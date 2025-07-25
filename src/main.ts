import * as core from '@actions/core';
import * as github from '@actions/github';
import { getChangedFiles, getReviews } from './github';
import { getReview } from './review';
import {
  OpenRouterAuthError,
  OpenRouterRateLimitError,
  OpenRouterApiError,
  OpenRouterTimeoutError,
  ConfigurationError,
  InvalidCustomRulesError,
} from './errors';

function validateInputs(): void {
  const maxTokens = parseInt(core.getInput('max_tokens'), 10);
  if (isNaN(maxTokens) || maxTokens <= 0 || maxTokens > 32768) {
    throw new RangeError(
      '`max_tokens` must be a positive integer between 1 and 32768'
    );
  }

  const temperature = parseFloat(core.getInput('temperature'));
  if (isNaN(temperature) || temperature < 0 || temperature > 2) {
    throw new RangeError('`temperature` must be a number between 0 and 2');
  }

  const retries = parseInt(core.getInput('retries'), 10);
  if (isNaN(retries) || retries < 0 || retries > 5) {
    throw new RangeError(
      '`retries` must be a non-negative integer between 0 and 5'
    );
  }

  const timeout = parseInt(core.getInput('request_timeout_seconds'), 10);
  if (!isNaN(timeout) && (timeout < 1 || timeout > 600)) {
    throw new RangeError(
      '`request_timeout_seconds` must be between 1 and 600 seconds'
    );
  }
}

export async function run(): Promise<void> {
  try {
    core.info('Starting AI PR Review Action...');
    core.info('DEBUG: Action is executing - this should appear in logs');
    validateInputs();

    const github_token = core.getInput('github_token', { required: true });
    const openrouter_api_key = core.getInput('openrouter_api_key', {
      required: true,
    });

    const octokit = github.getOctokit(github_token);
    const { context } = github;

    if (!context.payload.pull_request) {
      throw new TypeError(
        'This action can only be run on pull requests. Please ensure the workflow is triggered on pull_request events'
      );
    }

    const pr = context.payload.pull_request;

    const existingReviews = await getReviews(
      octokit,
      context.repo.owner,
      context.repo.repo,
      pr.number
    );
    if (
      existingReviews.some(
        review =>
          review.user?.login === 'github-actions[bot]' &&
          review.body.includes('## 🤖 AI Review by')
      )
    ) {
      core.info('An AI review already exists for this pull request. Skipping.');
      core.setOutput('review_status', 'skipped');
      return;
    }

    const changedFiles = await getChangedFiles(
      octokit,
      context.repo.owner,
      context.repo.repo,
      pr.number
    );
    core.info(`Found ${changedFiles.length} changed files.`);

    if (changedFiles.length === 0) {
      core.info('No changed files found. Skipping review.');
      core.setOutput('review_status', 'skipped');
      return;
    }

    const model = core.getInput('model');
    const maxTokens = parseInt(core.getInput('max_tokens'), 10);
    const temperature = parseFloat(core.getInput('temperature'));
    const timeout =
      parseInt(core.getInput('request_timeout_seconds'), 10) * 1000;
    const excludePatterns = core
      .getInput('exclude_patterns')
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0);
    const retries = parseInt(core.getInput('retries'), 10);
    const reviewType = core.getInput('review_type');
    const customRulesPath = core.getInput('custom_review_rules');
    const postComment = core.getInput('post_comment').toLowerCase() === 'true';

    const review = await getReview(
      openrouter_api_key,
      changedFiles,
      model,
      maxTokens,
      temperature,
      timeout,
      excludePatterns,
      pr.title,
      pr.body || '',
      reviewType,
      retries,
      customRulesPath
    );

    if (review) {
      core.info(
        `DEBUG: Setting outputs - review found with length: ${review.length}`
      );
      core.setOutput('review_comment', review);
      core.setOutput('review_status', 'success');
      core.info(
        `DEBUG: Outputs set - review_status: success, review_comment length: ${
          review.length
        }`
      );

      // Post comment if requested
      if (postComment) {
        core.info('Posting AI review comment to PR...');
        try {
          // Format comment with dynamic header and timestamp
          const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
          const currentTime = new Date().toLocaleTimeString('en-US', {
            timeZone: 'UTC',
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
          });

          // Extract model name for header (e.g., "gemini-2.5-pro" from "google/gemini-2.5-pro")
          const modelDisplayName = model.includes('/')
            ? model.split('/')[1]
            : model;
          const modelHeader =
            modelDisplayName.charAt(0).toUpperCase() +
            modelDisplayName.slice(1).replace(/-/g, ' ');

          // GitHub comment limit is ~65,536 characters, but let's be conservative
          const maxCommentLength = 60000;
          const footerText = `\n\n---\n*This review was automatically generated by \`${model}\` via OpenRouter on ${currentDate} at ${currentTime} UTC. Please consider it as supplementary feedback alongside human review.*`;

          let reviewContent = review;
          const headerText = `## 🤖 AI Review by ${modelHeader}\n\n`;
          const totalCommentLength =
            headerText.length + reviewContent.length + footerText.length;

          if (totalCommentLength > maxCommentLength) {
            core.info(
              `Review content too long (${totalCommentLength} chars). Truncating to fit within ${maxCommentLength} chars.`
            );
            const availableLength =
              maxCommentLength - headerText.length - footerText.length - 100; // Extra buffer
            const truncationMessage =
              '\n\n**[Review truncated due to length limits. See full review in action logs.]**';
            reviewContent =
              review.substring(0, availableLength - truncationMessage.length) +
              truncationMessage;
          }

          const formattedComment = `${headerText}${reviewContent}${footerText}`;

          await octokit.rest.issues.createComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: pr.number,
            body: formattedComment,
          });
          core.info('AI review comment posted successfully');
          core.info(`Final comment length: ${formattedComment.length} chars`);
          core.info(`Model header: ${modelHeader}`);
        } catch (commentError) {
          core.warning(
            `Failed to post comment: ${commentError instanceof Error ? commentError.message : String(commentError)}`
          );
          // Don't fail the action if comment posting fails - outputs are still set
        }
      } else {
        core.info('post_comment is false - review available in outputs only');
      }
    } else {
      core.info('DEBUG: No review generated - setting skipped status');
      core.setOutput('review_comment', '');
      core.setOutput('review_status', 'skipped');
      core.info('DEBUG: Outputs set - review_status: skipped');
    }
  } catch (error) {
    core.info('DEBUG: Error occurred, setting failure outputs');
    core.setOutput('review_status', 'failure');
    core.setOutput('review_comment', '');
    core.info('DEBUG: Error outputs set - review_status: failure');

    // 1. Handle custom error types
    if (error instanceof OpenRouterAuthError) {
      core.setFailed(error.message);
    } else if (error instanceof OpenRouterRateLimitError) {
      core.setFailed(
        `OpenRouter API rate limit exceeded. Please try again later${
          error.retryAfter ? ` (retry after ${error.retryAfter}s)` : ''
        }.`
      );
    } else if (error instanceof OpenRouterTimeoutError) {
      core.setFailed(
        `OpenRouter API request timed out after ${error.timeout}ms. Consider increasing request_timeout_seconds.`
      );
    } else if (error instanceof OpenRouterApiError) {
      const details = error.statusCode ? ` (HTTP ${error.statusCode})` : '';
      core.setFailed(`OpenRouter API error: ${error.message}${details}`);
    } else if (error instanceof InvalidCustomRulesError) {
      core.setFailed(
        `Invalid custom review rules in ${error.filePath}: ${error.message}`
      );
    } else if (error instanceof ConfigurationError) {
      core.setFailed(`Configuration error: ${error.message}`);
    }
    // 2. Handle standard JavaScript error types
    else if (error instanceof TypeError) {
      core.setFailed(
        `Configuration error: ${error.message}. Please check your action inputs.`
      );
    } else if (error instanceof RangeError) {
      core.setFailed(
        `Input validation error: ${error.message}. Please check your numeric inputs.`
      );
    }
    // 3. Handle generic Error with message pattern matching
    else if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();

      if (errorMessage.includes('github') || errorMessage.includes('api')) {
        core.setFailed(
          `GitHub API error: ${error.message}. Please check your GITHUB_TOKEN permissions.`
        );
      } else if (
        errorMessage.includes('openrouter') ||
        errorMessage.includes('unauthorized')
      ) {
        core.setFailed(
          `OpenRouter API error: ${error.message}. Please check your OPENROUTER_API_KEY.`
        );
      } else if (
        errorMessage.includes('network') ||
        errorMessage.includes('timeout')
      ) {
        core.setFailed(
          `Network error: ${error.message}. Please try again or check your connectivity.`
        );
      } else if (
        errorMessage.includes('pull request') ||
        errorMessage.includes('context')
      ) {
        core.setFailed(
          `Action context error: ${error.message}. This action must be run on pull requests.`
        );
      } else {
        core.setFailed(`Unexpected error: ${error.message}`);
      }
    }
    // 4. Handle non-Error objects (strings, numbers, objects, etc.)
    else {
      const errorMessage = String(error);
      core.setFailed(`Unknown error occurred: ${errorMessage}`);
    }
  }
}

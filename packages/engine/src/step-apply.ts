import {
  catalogPagesToRead,
  commandForOutput,
  type AgentOutput,
  type RoleOutput,
  type Task
} from '@officina/core';
import {
  addComment,
  appendRunEvent,
  applyCommand,
  finishRun,
  recordRunResult,
  saveSpecVersion,
  setTaskTitle
} from '@officina/db';
import type { RunnerRole } from '@officina/runner';
import type { PoolClient } from 'pg';
import { postChecklist, taskLink } from './github-sync';
import { openTaskPullRequest, type PushedBuild } from './pull-request';
import type { StepInputs } from './step-session';
import type { Step, StepResult } from './step';
import type { GitHubReview } from './validators';

/** Only the state the agent saw may receive its result. */
const sameWork = (seen: Task) => (current: Task) =>
  current.stage === seen.stage &&
  current.specVersion === seen.specVersion &&
  current.headSha === seen.headSha &&
  !current.blocked &&
  !current.paused;

/** A build result with the facts of what was really pushed, read from GitHub. */
const pushedOutput = async (step: Step, built: PushedBuild): Promise<RoleOutput> => {
  const { github } = step.deps;
  const facts = await github.pushFacts({
    ...step.repoRef,
    base: step.context.defaultBranch,
    branch: step.taskBranch
  });
  // The catalog check reads the pages as pushed, so an edit that does not name the new file does
  // not pass for listing it.
  const catalogPages: Record<string, string | null> = {};
  for (const page of catalogPagesToRead(step.config.docs.standards.catalogs, facts.addedPaths)) {
    catalogPages[page] =
      // At the head the diff was read from, so a later push cannot change what is checked.
      (await github.readFile({ ...step.repoRef, path: page, branch: facts.headSha }))?.text ?? null;
  }
  return { role: step.role, output: built, facts: { ...facts, catalogPages } } as RoleOutput;
};

/** Writes what a result adds besides its command, in the same transaction as the command. */
const recordAlongside =
  (step: Step, output: AgentOutput<RunnerRole>) =>
  async (client: PoolClient, task: Task): Promise<void> => {
    if (step.role === 'interviewer') {
      const interview = output as AgentOutput<'interviewer'>;
      // The thread keeps the whole conversation, so the spec writer and people read it as one.
      const body =
        interview.outcome === 'question'
          ? interview.question
          : [
              `**Summary.** ${interview.summary}`,
              `**Done when:**\n${interview.acceptance.map((item) => `- ${item}`).join('\n')}`
            ].join('\n\n');
      await addComment(client, step.taskId, step.actor, body);
      if (interview.outcome === 'complete') {
        await setTaskTitle(client, step.taskId, interview.title);
      }
    }
    if (step.role === 'spec' && (output as AgentOutput<'spec'>).outcome === 'specced') {
      await saveSpecVersion(client, {
        taskId: step.taskId,
        version: task.specVersion,
        body: (output as Extract<AgentOutput<'spec'>, { outcome: 'specced' }>).spec,
        createdBy: step.actor
      });
    }
  };

/** The pull request of a round that just reached review; a failure is left to the scheduler. */
const openPullRequestAfter = async (step: Step, built: PushedBuild) => {
  const { pool } = step.deps;
  try {
    const pr = await openTaskPullRequest(pool, step.deps.github, {
      taskId: step.taskId,
      publicUrl: step.deps.publicUrl,
      built
    });
    if (pr) await appendRunEvent(pool, step.runId, 'officina.pull_request_opened', pr);
  } catch (error) {
    // The round is applied; the scheduler opens the pull request from the recorded result.
    await appendRunEvent(pool, step.runId, 'officina.pull_request_failed', {
      error: (error as Error).message
    });
  }
};

/** The builder's answer to the GitHub reviews this round addressed, posted on the pull request. */
const replyToReviews = async (step: Step, reply: string, reviews: readonly GitHubReview[]) => {
  const pullRequest = step.context.pullRequest;
  if (reviews.length === 0 || pullRequest === null) return;
  const reviewers = [...new Set(reviews.map((review) => `\`${review.by}\``))];
  try {
    await step.deps.github.commentOnIssue({
      ...step.repoRef,
      issueNumber: pullRequest,
      body: `Answer to the review by ${reviewers.join(', ')}.\n\n${reply}`
    });
  } catch (error) {
    // The round is applied either way; a lost reply must not block the task.
    await appendRunEvent(step.deps.pool, step.runId, 'officina.review_reply_failed', {
      error: (error as Error).message
    });
  }
};

/** What an applied result leaves on GitHub: the pull request, a review answer, the checklist. */
const mirrorToGitHub = async (
  step: Step,
  output: AgentOutput<RunnerRole>,
  stage: Task['stage'],
  inputs: StepInputs
) => {
  const { context } = step;
  if (step.builds && stage === 'reviewing' && context.pullRequest === null) {
    await openPullRequestAfter(step, output as PushedBuild);
  }
  const reply = step.builds && 'reviewReply' in output ? output.reviewReply : undefined;
  if (reply) await replyToReviews(step, reply, inputs.githubReviews);
  if (step.role === 'chooser' && context.pullRequest !== null) {
    await postChecklist(step.deps.pool, step.deps.github, {
      taskId: step.taskId,
      ref: step.repoRef,
      pullRequest: context.pullRequest,
      taskLink: taskLink(step.deps.publicUrl, context.number),
      result: output
    });
  }
};

/** Turns the agent's result into its command, with push facts for a build, or why it cannot be. */
export const roleOutputOf = async (
  step: Step,
  output: AgentOutput<RunnerRole>
): Promise<RoleOutput | { readonly wrongBranch: string }> => {
  if (!step.builds) return { role: step.role, output } as RoleOutput;
  const built = output as AgentOutput<'builder' | 'onboarder'>;
  if (built.outcome !== 'pushed') return { role: step.role, output: built } as RoleOutput;
  if (built.branch !== step.taskBranch) return { wrongBranch: built.branch };
  return pushedOutput(step, built);
};

/** A valid result, the command input it maps to, and what its session cost. */
export interface StepOutcome {
  readonly output: AgentOutput<RunnerRole>;
  readonly roleOutput: RoleOutput;
  readonly costCents: number | null;
}

/** Applies a valid result to the work the agent saw, then mirrors it to GitHub. */
export const applyResult = async (
  step: Step,
  { output, roleOutput, costCents }: StepOutcome,
  inputs: StepInputs
): Promise<StepResult> => {
  const { pool } = step.deps;
  const mapped = commandForOutput(step.context.task, roleOutput);
  if (!mapped.ok) throw new Error(mapped.error);
  // Recorded before it is applied, so a crash after the apply still leaves what to open the pull
  // request from.
  await recordRunResult(pool, step.runId, output);
  const applied = await applyCommand(pool, {
    taskId: step.taskId,
    command: mapped.command,
    actor: step.actor,
    guard: sameWork(step.context.task),
    onApplied: recordAlongside(step, output)
  });
  if (!applied.ok) {
    await finishRun(pool, step.runId, {
      status: 'failed',
      costCents,
      result: { discarded: applied.error, output }
    });
    return { status: 'discarded', reason: applied.error };
  }
  await mirrorToGitHub(step, output, applied.task.stage, inputs);
  await finishRun(pool, step.runId, {
    status: 'succeeded',
    costCents,
    result: output
  });
  return { status: 'applied' };
};

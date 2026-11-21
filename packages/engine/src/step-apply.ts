import {
  commandForOutput,
  errorText,
  questionMarkdown,
  splitMarkdown,
  splitPaths,
  type AgentOutput,
  type RoleOutput,
  type RunUsage,
  type Task
} from '@officina/core';
import {
  addComment,
  appendRunEvent,
  applyCommand,
  finishRun,
  recordRunResult,
  runIsActive,
  runWasPaused,
  saveSpecVersion,
  setTaskTitle
} from '@officina/db';
import type { RunnerRole } from '@officina/runner';
import type { PoolClient } from 'pg';
import { syncChecklistComment } from './checklist';
import { openTaskPullRequest, readPush, sendBackRedChecks, type PushedBuild } from './pull-request';
import type { StepInputs } from './step-session';
import type { Step, StepResult } from './step';
import type { GitHubReview } from './validators';

const sameAssignee = (a: Task['assignee'], b: Task['assignee']): boolean => {
  if (a === null || b === null) return a === b;
  if (a.kind === 'member') return b.kind === 'member' && a.memberId === b.memberId;
  return b.kind === 'agent' && a.role === b.role;
};

const sameFields = (seen: Task, current: Task) =>
  current.stage === seen.stage &&
  current.specVersion === seen.specVersion &&
  current.headSha === seen.headSha &&
  sameAssignee(current.assignee, seen.assignee) &&
  !current.blocked &&
  !current.paused;

/**
 * Only the state the agent saw may receive its result, or its failure, and only while its own run
 * is still in progress and its task was never paused meanwhile: a build a member took over is
 * theirs, and nothing the agent's run ends with applies to it, even once the same role builds the
 * task again after the member let go; a pause ends the run's part the same way, even once the task
 * is resumed.
 */
export const sameWork =
  (seen: Task, runId: string) =>
  async (current: Task, client: PoolClient): Promise<boolean> =>
    sameFields(seen, current) &&
    (await runIsActive(client, runId)) &&
    !(await runWasPaused(client, runId));

/** A build result with the facts of what was really pushed, read from GitHub. */
const pushedOutput = async (step: Step, built: PushedBuild): Promise<RoleOutput> => {
  const facts = await readPush(step.deps.github, step.repoRef, {
    base: step.context.defaultBranch,
    branch: step.taskBranch,
    catalogs: step.config.docs.standards.catalogs
  });
  return { role: step.role, output: built, facts } as RoleOutput;
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
          ? questionMarkdown(interview.question, interview.options)
          : interview.outcome === 'needs_person'
            ? `${interview.why}\n\n**Needed:**\n${interview.asks.map((ask) => `- ${ask}`).join('\n')}`
            : [
                `**Summary.** ${interview.summary}`,
                `**Done when:**\n${interview.acceptance.map((item) => `- ${item}`).join('\n')}`
              ].join('\n\n');
      await addComment(client, step.taskId, step.actor, body);
      if (interview.outcome === 'complete') {
        await setTaskTitle(client, step.taskId, interview.title);
      }
    }
    if (step.role === 'spec')
      await saveSpecOutput(client, step, task, output as AgentOutput<'spec'>);
  };

/** A spec, or a proposed split as the version people read, with its sub-tasks kept beside it. */
const saveSpecOutput = async (
  client: PoolClient,
  step: Step,
  task: Task,
  output: AgentOutput<'spec'>
): Promise<void> => {
  const version = { taskId: step.taskId, version: task.specVersion, createdBy: step.actor };
  if (output.outcome === 'specced') {
    await saveSpecVersion(client, {
      ...version,
      body: output.spec,
      predictedPaths: output.predictedPaths
    });
  }
  if (output.outcome === 'split') {
    const split = { why: output.why, subtasks: output.subtasks };
    await saveSpecVersion(client, {
      ...version,
      body: splitMarkdown(split),
      predictedPaths: splitPaths(split),
      split
    });
  }
};

/**
 * A GitHub write after the round is applied: a failure is recorded on the run and never thrown, so
 * it neither fails the run nor blocks the task. `null` when it failed.
 */
const afterApplied = async <T>(
  step: Step,
  failedEvent: string,
  write: () => Promise<T>
): Promise<T | null> => {
  try {
    return await write();
  } catch (error) {
    await appendRunEvent(step.deps.pool, step.runId, failedEvent, { error: errorText(error) });
    return null;
  }
};

/** The pull request of a round that just reached review; a failure is left to the scheduler. */
const openPullRequestAfter = (step: Step, built: PushedBuild) =>
  afterApplied(step, 'officina.pull_request_failed', async () => {
    const { pool } = step.deps;
    const pr = await openTaskPullRequest(pool, step.deps.github, {
      taskId: step.taskId,
      publicUrl: step.deps.publicUrl,
      built
    });
    if (pr) await appendRunEvent(pool, step.runId, 'officina.pull_request_opened', pr);
    return pr;
  });

/**
 * Checks that failed on the pushed head before the push was applied, which no webhook reports
 * again since no task held that head then; a failure to read them is recorded on the run.
 */
const redChecksAfter = async (step: Step, output: AgentOutput<RunnerRole>, task: Task) => {
  if (!step.builds || (output as Partial<PushedBuild>).outcome !== 'pushed') return;
  await afterApplied(step, 'officina.checks_read_failed', async () => {
    await sendBackRedChecks(
      step.deps.pool,
      step.deps.github,
      { taskId: step.taskId, ref: step.repoRef, branch: step.taskBranch },
      task
    );
  });
};

/** The builder's answer to the GitHub reviews this round addressed, posted on the pull request. */
const replyToReviews = async (step: Step, reply: string, reviews: readonly GitHubReview[]) => {
  const pullRequest = step.context.pullRequest;
  if (reviews.length === 0 || pullRequest === null) return;
  const reviewers = [...new Set(reviews.map((review) => `\`${review.by}\``))];
  await afterApplied(step, 'officina.review_reply_failed', async () => {
    await step.deps.github.commentOnIssue({
      ...step.repoRef,
      issueNumber: pullRequest,
      body: `Answer to the review by ${reviewers.join(', ')}.\n\n${reply}`
    });
  });
};

/**
 * The task's pull request after the round: the one linked already, or the one a build that just
 * reached review opens; `null` while none is linked.
 */
const pullRequestAfter = async (
  step: Step,
  output: AgentOutput<RunnerRole>,
  stage: Task['stage']
): Promise<number | null> => {
  const linked = step.context.pullRequest;
  if (linked !== null || !step.builds || stage !== 'reviewing') return linked;
  return (await openPullRequestAfter(step, output as PushedBuild))?.number ?? null;
};

/**
 * What an applied result leaves on GitHub: the pull request, a review answer, the checklist. The
 * task's pull request after it, `null` while none is linked.
 */
const mirrorToGitHub = async (
  step: Step,
  output: AgentOutput<RunnerRole>,
  stage: Task['stage'],
  inputs: StepInputs
): Promise<number | null> => {
  const { context } = step;
  const linked = await pullRequestAfter(step, output, stage);
  const reply = step.builds && 'reviewReply' in output ? output.reviewReply : undefined;
  if (reply) await replyToReviews(step, reply, inputs.githubReviews);
  const pullRequest = context.pullRequest;
  if (step.role === 'chooser' && pullRequest !== null) {
    await afterApplied(step, 'officina.checklist_failed', () =>
      syncChecklistComment(step.deps.pool, step.deps.github, {
        taskId: step.taskId,
        publicUrl: step.deps.publicUrl
      })
    );
  }
  return linked;
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

/** A valid result, the command input it maps to, and what its session used. */
export interface StepOutcome {
  readonly output: AgentOutput<RunnerRole>;
  readonly roleOutput: RoleOutput;
  readonly usage: RunUsage;
}

/** Applies a valid result to the work the agent saw, then mirrors it to GitHub. */
export const applyResult = async (
  step: Step,
  { output, roleOutput, usage }: StepOutcome,
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
    guard: sameWork(step.context.task, step.runId),
    onApplied: recordAlongside(step, output)
  });
  if (!applied.ok) {
    await finishRun(pool, step.runId, {
      status: 'failed',
      usage,
      result: { discarded: applied.error, output }
    });
    return { status: 'discarded', reason: applied.error };
  }
  const pullRequest = await mirrorToGitHub(step, output, applied.task.stage, inputs);
  // A head whose pull request failed to open stays in review, where the catch-up opens it: sent
  // back to the build it would wait for a pull request nothing opens.
  if (pullRequest !== null) await redChecksAfter(step, output, applied.task);
  await finishRun(pool, step.runId, {
    status: 'succeeded',
    usage,
    result: output
  });
  return { status: 'applied' };
};

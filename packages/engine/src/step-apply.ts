import {
  commandForOutput,
  questionMarkdown,
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
  runIsActive,
  saveSpecVersion,
  setTaskTitle
} from '@officina/db';
import type { RunnerRole } from '@officina/runner';
import type { PoolClient } from 'pg';
import { postChecklist, taskLink } from './github-sync';
import { openTaskPullRequest, readPush, type PushedBuild } from './pull-request';
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
 * is still in progress: a build a member took over meanwhile is theirs, and nothing the agent's run
 * ends with applies to it, even once the same role builds the task again after the member let go.
 */
export const sameWork =
  (seen: Task, runId: string) =>
  async (current: Task, client: PoolClient): Promise<boolean> =>
    sameFields(seen, current) && (await runIsActive(client, runId));

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
    if (step.role === 'spec' && (output as AgentOutput<'spec'>).outcome === 'specced') {
      await saveSpecVersion(client, {
        taskId: step.taskId,
        version: task.specVersion,
        body: (output as Extract<AgentOutput<'spec'>, { outcome: 'specced' }>).spec,
        createdBy: step.actor
      });
    }
  };

/**
 * A GitHub write after the round is applied: a failure is recorded on the run and never thrown, so
 * it neither fails the run nor blocks the task.
 */
const afterApplied = async (step: Step, failedEvent: string, write: () => Promise<void>) => {
  try {
    await write();
  } catch (error) {
    await appendRunEvent(step.deps.pool, step.runId, failedEvent, {
      error: (error as Error).message
    });
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
  });

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
  const pullRequest = context.pullRequest;
  if (step.role === 'chooser' && pullRequest !== null) {
    await afterApplied(step, 'officina.checklist_failed', () =>
      postChecklist(step.deps.pool, step.deps.github, {
        taskId: step.taskId,
        ref: step.repoRef,
        pullRequest,
        taskLink: taskLink(step.deps.publicUrl, context.projectId, context.number),
        result: output
      })
    );
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
    guard: sameWork(step.context.task, step.runId),
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

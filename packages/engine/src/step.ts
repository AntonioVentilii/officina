import {
  branchForTask,
  catalogPagesToRead,
  commandForOutput,
  ENGINE,
  isBuildRole,
  nextAgentRoles,
  type Actor,
  type AgentOutput,
  type RoleOutput,
  type Task
} from '@officina/core';
import {
  addComment,
  appendRunEvent,
  applyCommand,
  countInterviewQuestions,
  feedbackSinceLastPush,
  finishRun,
  githubReviewsSinceLastPush,
  latestPushedPaths,
  listProjectMemberProfiles,
  listComments,
  recordRunResult,
  saveSpecVersion,
  setRunExternalId,
  setTaskTitle
} from '@officina/db';
import {
  copilotVerdict,
  type GitHubClient,
  type RefSnapshot,
  type RepoRef
} from '@officina/github';
import {
  executeRun,
  type ManagedAgentsPort,
  type RunnerRole,
  type RunOutcome,
  type RunReport
} from '@officina/runner';
import type { Pool, PoolClient } from 'pg';
import { claimStep, type ClaimedStep, type SkipReason } from './claim';
import { MAX_INTERVIEW_QUESTIONS, buildBrief, type ChooserContext } from './brief';
import { runLearnerStep } from './learner';
import { postChecklist, taskLink, type SyncGitHubPort } from './github-sync';
import { openTaskPullRequest, type PushedBuild } from './pull-request';

export { taskLink };

export type GitHubPort = Pick<
  GitHubClient,
  'installationToken' | 'openPullRequest' | 'refSnapshot' | 'isPullRequestMerge'
> &
  SyncGitHubPort;

export interface EngineDependencies {
  readonly pool: Pool;
  readonly github: GitHubPort;
  readonly agents: ManagedAgentsPort;
  /** Where people open a task, e.g. `https://officina.example`; task links in pull requests use it. */
  readonly publicUrl: string;
  /** Officina's own role prompts, so the learner's edits to them can be checked before people see them. */
  readonly promptsDir?: string | undefined;
}

const INTERVIEW_BUDGET_CENTS = 200;

const interviewProblems = (asked: number) => (output: AgentOutput<RunnerRole>) =>
  (output as AgentOutput<'interviewer'>).outcome === 'question' && asked >= MAX_INTERVIEW_QUESTIONS
    ? [`you have asked ${asked} questions already: complete the request now`]
    : [];

const planProblems =
  (gate: 'spec_review' | 'verifying', memberIds: ReadonlySet<string>) =>
  (output: AgentOutput<RunnerRole>) => {
    const chosen = output as AgentOutput<'chooser'>;
    const problems = chosen.approval.verifiers
      .filter((verifier) => !memberIds.has(verifier.memberId))
      .map((verifier) => `verifier ${verifier.memberId} is not a member of this project`);
    if (gate === 'verifying' && chosen.checklist.length === 0)
      problems.push('checklist: at verification the checklist must have at least one step');
    return problems;
  };

const titleProblems = (pattern: string | null) => (output: AgentOutput<RunnerRole>) => {
  const built = output as AgentOutput<'builder' | 'onboarder'>;
  if (!pattern || built.outcome !== 'pushed' || new RegExp(pattern).test(built.prTitle)) return [];
  return [`prTitle "${built.prTitle}" does not match the required pattern ${pattern}`];
};

type GitHubReview = { readonly by: string; readonly notes: string };

/**
 * A build round may end `unchanged` only when it answers a GitHub review, and a round answering a
 * Copilot review that asked for a closer look must say what it checked, even when nothing changed.
 */
const reviewProblems =
  (reviews: readonly GitHubReview[]) =>
  (output: AgentOutput<RunnerRole>): string[] => {
    const built = output as AgentOutput<'builder' | 'onboarder'>;
    const problems: string[] = [];
    if (built.outcome === 'unchanged' && reviews.length === 0) {
      problems.push('`unchanged` only answers a GitHub review, and this round has none');
    }
    const answers = built.outcome === 'pushed' || built.outcome === 'unchanged';
    const closerLook = reviews.some((review) => copilotVerdict(review.notes) === 'closer_look');
    if (answers && closerLook && !('reviewReply' in built && built.reviewReply)) {
      problems.push('a review that asked for a closer look needs `reviewReply`');
    }
    return problems;
  };

export type StepResult =
  | { readonly status: 'applied' }
  | { readonly status: 'blocked'; readonly reason: string }
  | { readonly status: 'discarded'; readonly reason: string }
  | { readonly status: 'skipped'; readonly reason: SkipReason };

const describeOutcome = (outcome: Exclude<RunOutcome, { kind: 'result' }>): string => {
  switch (outcome.kind) {
    case 'invalid_result':
      return `its result did not match the contract: ${outcome.errors.join('; ')}`;
    case 'no_result':
      return 'it finished without submitting a result';
    case 'budget_reached':
      return 'it reached the spending limit for this step';
    case 'failed':
      return outcome.reason;
  }
};

/** Only the state the agent saw may receive its result. */
const sameWork = (seen: Task) => (current: Task) =>
  current.stage === seen.stage &&
  current.specVersion === seen.specVersion &&
  current.headSha === seen.headSha &&
  !current.blocked &&
  !current.paused;

/**
 * What changed outside the task's own branch while a builder held a token that can write any ref.
 * The default branch may move forward by a pull request merged meanwhile, which went through the
 * branch rules; any other move, and any tag created, moved or deleted, is reported.
 */
const refChanges = async (
  github: GitHubPort,
  ref: RepoRef & { readonly defaultBranch: string },
  before: RefSnapshot,
  after: RefSnapshot
): Promise<string[]> => {
  const changes: string[] = [];
  if (
    before.defaultHead !== after.defaultHead &&
    !(await github.isPullRequestMerge({
      ...ref,
      sha: after.defaultHead,
      base: ref.defaultBranch,
      since: before.defaultHead
    }))
  ) {
    changes.push(
      `${ref.defaultBranch} moved from ${before.defaultHead.slice(0, 7)} to ${after.defaultHead.slice(0, 7)}`
    );
  }
  for (const [tag, sha] of Object.entries(after.tags)) {
    if (!(tag in before.tags)) changes.push(`tag ${tag} was created`);
    else if (before.tags[tag] !== sha) changes.push(`tag ${tag} was moved`);
  }
  for (const tag of Object.keys(before.tags)) {
    if (!(tag in after.tags)) changes.push(`tag ${tag} was deleted`);
  }
  return changes;
};

const blockTask = async (pool: Pool, taskId: string, question: string) => {
  await applyCommand(pool, {
    taskId,
    command: { type: 'block', question, askedOf: { role: 'maintainer' } },
    actor: ENGINE
  });
};

/** One claimed run of a role on a task, and what every phase of the step reads. */
interface Step extends ClaimedStep {
  readonly deps: EngineDependencies;
  readonly taskId: string;
  readonly role: RunnerRole;
  readonly actor: Actor;
  readonly taskBranch: string;
  readonly builds: boolean;
}

/** What the step gathered before the session that its checks and its follow-up still need. */
interface StepInputs {
  readonly members: Awaited<ReturnType<typeof listProjectMemberProfiles>>;
  readonly questionsAsked: number;
  readonly githubReviews: readonly GitHubReview[];
}

const gatherInputs = async (step: Step): Promise<StepInputs> => ({
  members:
    step.role === 'chooser'
      ? await listProjectMemberProfiles(step.deps.pool, step.context.projectId)
      : [],
  questionsAsked:
    step.role === 'interviewer' ? await countInterviewQuestions(step.deps.pool, step.taskId) : 0,
  githubReviews: step.builds ? await githubReviewsSinceLastPush(step.deps.pool, step.taskId) : []
});

const gateOf = (step: Step) =>
  step.context.task.stage === 'spec_review' ? ('spec_review' as const) : ('verifying' as const);

const chooserContext = async (step: Step, inputs: StepInputs): Promise<ChooserContext> => {
  const { context, config } = step;
  const lane = context.task.lane ?? 'standard';
  const gate = gateOf(step);
  return {
    gate,
    lane,
    userVisible: context.task.userVisible,
    lanePolicy: config.lanes[lane].approvals[gate],
    previousPlan: context.task.approvalPlans[gate] ?? null,
    members: inputs.members,
    requesterName:
      inputs.members.find((member) => member.id === context.task.requesterId)?.name ??
      'a former member',
    changedPaths: gate === 'verifying' ? await latestPushedPaths(step.deps.pool, step.taskId) : [],
    autoMergeAllowed: config.pullRequest.autoMerge
  };
};

const briefFor = async (step: Step, inputs: StepInputs) => {
  const { context, config, role, taskId } = step;
  const { pool } = step.deps;
  return buildBrief({
    role,
    taskNumber: context.number,
    title: context.title,
    repo: context.repo,
    defaultBranch: context.defaultBranch,
    taskBranch: step.taskBranch,
    docsEntry: config.docs.entry,
    specTemplate: config.docs.specTemplate,
    specVersion: context.task.specVersion,
    spec: context.latestSpec,
    verify: config.verify,
    protectedPaths: config.lanes.red.paths,
    requestThread:
      role === 'spec' || role === 'interviewer' ? await listComments(pool, taskId) : [],
    feedback: step.builds ? await feedbackSinceLastPush(pool, taskId) : [],
    firstRound: context.task.headSha === null,
    prTitlePattern: config.pullRequest.titlePattern,
    chooser: role === 'chooser' ? await chooserContext(step, inputs) : undefined,
    questionsAsked: inputs.questionsAsked,
    standards: role === 'onboarder' ? config.docs.standards : undefined
  });
};

/** The project's checks on a result, beyond its contract; their problems go back to the agent. */
const validatorFor = (step: Step, inputs: StepInputs) => {
  if (step.builds) {
    return (output: AgentOutput<RunnerRole>) => [
      ...titleProblems(step.config.pullRequest.titlePattern)(output),
      // The onboarder's contract has no review answer, so only the builder is held to one.
      ...(step.role === 'builder' ? reviewProblems(inputs.githubReviews)(output) : [])
    ];
  }
  if (step.role === 'chooser') {
    return planProblems(gateOf(step), new Set(inputs.members.map((member) => member.id)));
  }
  return step.role === 'interviewer' ? interviewProblems(inputs.questionsAsked) : undefined;
};

const runSession = async (step: Step, inputs: StepInputs, token: string) => {
  const { context, config, role, runId, agent } = step;
  const { pool } = step.deps;
  const lane = context.task.lane ?? 'standard';
  return executeRun(step.deps.agents, {
    role,
    brief: await briefFor(step, inputs),
    session: {
      agentId: agent.externalAgentId,
      agentVersion: agent.version,
      environmentId: step.environmentId,
      title: `Officina #${context.number} ${role}`,
      metadata: { task_id: step.taskId, run_id: runId, role },
      repository: {
        url: `https://github.com/${context.repo}`,
        token,
        // Until the first push the task branch does not exist yet.
        branch:
          role === 'spec' || context.task.headSha === null ? context.defaultBranch : step.taskBranch
      },
      // A conversation is cheap; a lane's build budget would be far too generous for it.
      budgetCents:
        role === 'interviewer'
          ? INTERVIEW_BUDGET_CENTS
          : Math.round(config.lanes[lane].budgetUsd * 100)
    },
    validate: validatorFor(step, inputs),
    onSessionCreated: (sessionId) => setRunExternalId(pool, runId, sessionId),
    onEvent: (event) => appendRunEvent(pool, runId, event.type, event)
  });
};

/** Fails the run with what it left and asks a maintainer, so the scheduler does not retry it. */
const failAndBlock = async (
  step: Step,
  run: { readonly costCents: number | null; readonly result: unknown },
  question: string,
  reason: string
): Promise<StepResult> => {
  await finishRun(step.deps.pool, step.runId, { status: 'failed', ...run });
  await blockTask(step.deps.pool, step.taskId, question);
  return { status: 'blocked', reason };
};

/** The refs a builder could have moved besides its own branch, checked after every build run. */
const guardRefs = async (step: Step, before: RefSnapshot, report: RunReport) => {
  const guarded = { ...step.repoRef, defaultBranch: step.context.defaultBranch };
  const after = await step.deps.github.refSnapshot(guarded);
  const changes = await refChanges(step.deps.github, guarded, before, after);
  if (!changes.length) return null;
  const { role, taskBranch } = step;
  return failAndBlock(
    step,
    { costCents: report.costCents, result: { refsChanged: changes, outcome: report.outcome } },
    `While the ${role} ran, ${changes.join('; ')}. The ${role} may only push ${taskBranch}. Check those refs on GitHub and restore them if the ${role} changed them; if a person made the change, answer to run the build again.`,
    `refs outside ${taskBranch} changed during the build: ${changes.join('; ')}`
  );
};

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
const roleOutputOf = async (
  step: Step,
  output: AgentOutput<RunnerRole>
): Promise<RoleOutput | { readonly wrongBranch: string }> => {
  if (!step.builds) return { role: step.role, output } as RoleOutput;
  const built = output as AgentOutput<'builder' | 'onboarder'>;
  if (built.outcome !== 'pushed') return { role: step.role, output: built } as RoleOutput;
  if (built.branch !== step.taskBranch) return { wrongBranch: built.branch };
  return pushedOutput(step, built);
};

/** Applies a valid result to the work the agent saw, then mirrors it to GitHub. */
const applyResult = async (
  step: Step,
  report: RunReport & { readonly outcome: { readonly kind: 'result' } },
  inputs: StepInputs
): Promise<StepResult> => {
  const { pool } = step.deps;
  const output = (report.outcome as Extract<RunOutcome, { kind: 'result' }>).output;
  const roleOutput = await roleOutputOf(step, output);
  if ('wrongBranch' in roleOutput) {
    const reason = `it pushed to ${roleOutput.wrongBranch} instead of ${step.taskBranch}`;
    return failAndBlock(
      step,
      { costCents: report.costCents, result: output },
      `The ${step.role} agent could not complete its step: ${reason}.`,
      reason
    );
  }
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
      costCents: report.costCents,
      result: { discarded: applied.error, output }
    });
    return { status: 'discarded', reason: applied.error };
  }
  await mirrorToGitHub(step, output, applied.task.stage, inputs);
  await finishRun(pool, step.runId, {
    status: 'succeeded',
    costCents: report.costCents,
    result: output
  });
  return { status: 'applied' };
};

/** From the session to the applied result, for a run already claimed. */
const runClaimed = async (step: Step): Promise<StepResult> => {
  const inputs = await gatherInputs(step);
  const { github } = step.deps;
  // Only the build roles get a token that can push; every other role reads.
  const token = await github.installationToken(step.repoRef, {
    contents: step.builds ? 'write' : 'read'
  });
  // Taken before the session starts, so nothing the builder does can land before it.
  const refsBefore = step.builds
    ? await github.refSnapshot({ ...step.repoRef, defaultBranch: step.context.defaultBranch })
    : null;
  const report = await runSession(step, inputs, token);
  // Checked whatever the run reported: a failed run may still have pushed somewhere.
  const moved = refsBefore ? await guardRefs(step, refsBefore, report) : null;
  if (moved) return moved;
  if (report.outcome.kind !== 'result') {
    const reason = describeOutcome(report.outcome);
    return failAndBlock(
      step,
      { costCents: report.costCents, result: report.outcome },
      `The ${step.role} agent could not complete its step: ${reason}.`,
      reason
    );
  }
  return applyResult(
    step,
    report as RunReport & { readonly outcome: { readonly kind: 'result' } },
    inputs
  );
};

/** Runs one agent role for one task, from claiming the run to applying (or discarding) its result. */
export const runAgentStep = async (
  deps: EngineDependencies,
  taskId: string,
  role: RunnerRole
): Promise<StepResult> => {
  if (role === 'learner') return runLearnerStep(deps, taskId);
  const claimed = await claimStep(deps.pool, {
    taskId,
    role,
    isDue: (context) => nextAgentRoles(context.task).includes(role)
  });
  if (!claimed.ok) return { status: 'skipped', reason: claimed.reason };
  const step: Step = {
    ...claimed.step,
    deps,
    taskId,
    role,
    actor: { kind: 'agent', role, version: claimed.step.agent.version },
    taskBranch: branchForTask(claimed.step.context.number),
    builds: isBuildRole(role)
  };
  try {
    return await runClaimed(step);
  } catch (error) {
    const message = (error as Error).message;
    await finishRun(deps.pool, step.runId, {
      status: 'failed',
      costCents: null,
      result: { error: message }
    });
    // Blocking stops the scheduler from retrying a step that fails the same way every time;
    // answering the question retries it.
    await blockTask(
      deps.pool,
      taskId,
      `The ${role} step failed unexpectedly: ${message}. Answer this question to retry it.`
    ).catch(() => {});
    throw error;
  }
};

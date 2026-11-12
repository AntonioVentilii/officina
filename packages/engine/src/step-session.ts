import { type AgentOutput } from '@officina/core';
import {
  appendRunEvent,
  countInterviewQuestions,
  feedbackSinceLastPush,
  githubReviewsSinceLastPush,
  latestPushedPaths,
  listComments,
  listProjectMemberProfiles,
  setRunExternalId
} from '@officina/db';
import { executeRun, type RunnerRole } from '@officina/runner';
import { buildBrief, type ChooserContext } from './brief';
import type { Step } from './step';
import {
  interviewProblems,
  planProblems,
  reviewProblems,
  titleProblems,
  type GitHubReview
} from './validators';

const INTERVIEW_BUDGET_CENTS = 200;

/** What the step gathered before the session that its checks and its follow-up still need. */
export interface StepInputs {
  readonly members: Awaited<ReturnType<typeof listProjectMemberProfiles>>;
  readonly questionsAsked: number;
  readonly githubReviews: readonly GitHubReview[];
}

export const gatherInputs = async (step: Step): Promise<StepInputs> => ({
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

export const runSession = async (step: Step, inputs: StepInputs, token: string) => {
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

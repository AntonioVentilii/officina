import {
  branchForTask,
  catalogPagesToRead,
  commandForOutput,
  ENGINE,
  isBuildRole,
  nextAgentRoles,
  parseProjectConfig,
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
  loadAgentVersions,
  loadTaskContext,
  recordRunResult,
  saveSpecVersion,
  setRunExternalId,
  setTaskTitle,
  startRun
} from '@officina/db';
import {
  copilotVerdict,
  type GitHubClient,
  type RefSnapshot,
  type RepoRef
} from '@officina/github';
import {
  executeRun,
  RUNNER,
  type ManagedAgentsPort,
  type RunnerRole,
  type RunOutcome
} from '@officina/runner';
import type { Pool } from 'pg';
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

/**
 * A markdown link to a task. A bare `#N` would link the repository's issue or pull request N.
 */

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
  | {
      readonly status: 'skipped';
      readonly reason:
        | 'not_found'
        | 'not_due'
        | 'not_installed'
        | 'no_environment'
        | 'agent_not_synced'
        | 'invalid_config'
        | 'already_running';
    };

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

/** Runs one agent role for one task, from claiming the run to applying (or discarding) its result. */
export const runAgentStep = async (
  deps: EngineDependencies,
  taskId: string,
  role: RunnerRole
): Promise<StepResult> => {
  if (role === 'learner') return runLearnerStep(deps, taskId);
  const { pool } = deps;
  const context = await loadTaskContext(pool, taskId);
  if (!context) return { status: 'skipped', reason: 'not_found' };
  if (!nextAgentRoles(context.task).includes(role)) return { status: 'skipped', reason: 'not_due' };
  if (context.installationId === null) return { status: 'skipped', reason: 'not_installed' };
  if (context.environmentId === null) return { status: 'skipped', reason: 'no_environment' };
  const environmentId = context.environmentId;
  const agent = (await loadAgentVersions(pool)).find((record) => record.role === role);
  if (!agent) return { status: 'skipped', reason: 'agent_not_synced' };
  const parsedConfig = parseProjectConfig(context.rawConfig);
  if (!parsedConfig.ok) return { status: 'skipped', reason: 'invalid_config' };
  const config = parsedConfig.config;

  const claim = await startRun(pool, {
    taskId,
    stage: context.task.stage,
    role,
    agentVersion: agent.version,
    runner: RUNNER
  });
  if (!claim.ok) return { status: 'skipped', reason: 'already_running' };
  const runId = claim.runId;
  const actor: Actor = { kind: 'agent', role, version: agent.version };
  const repoRef = { installationId: context.installationId, repo: context.repo };
  const taskBranch = branchForTask(context.number);
  const firstRound = context.task.headSha === null;
  const members =
    role === 'chooser' ? await listProjectMemberProfiles(pool, context.projectId) : [];
  const questionsAsked = role === 'interviewer' ? await countInterviewQuestions(pool, taskId) : 0;
  const githubReviews = isBuildRole(role) ? await githubReviewsSinceLastPush(pool, taskId) : [];

  try {
    const builds = isBuildRole(role);
    // Only the build roles get a token that can push; every other role reads.
    const token = await deps.github.installationToken(repoRef, {
      contents: builds ? 'write' : 'read'
    });
    const guardedRefs = { ...repoRef, defaultBranch: context.defaultBranch };
    // Taken before the session starts, so nothing the builder does can land before it.
    const refsBefore = builds ? await deps.github.refSnapshot(guardedRefs) : null;
    const lane = context.task.lane ?? 'standard';
    const gate = context.task.stage === 'spec_review' ? 'spec_review' : 'verifying';
    const chooser: ChooserContext | undefined =
      role === 'chooser'
        ? {
            gate,
            lane,
            userVisible: context.task.userVisible,
            lanePolicy: config.lanes[lane].approvals[gate],
            previousPlan: context.task.approvalPlans[gate] ?? null,
            members,
            requesterName:
              members.find((member) => member.id === context.task.requesterId)?.name ??
              'a former member',
            changedPaths: gate === 'verifying' ? await latestPushedPaths(pool, taskId) : [],
            autoMergeAllowed: config.pullRequest.autoMerge
          }
        : undefined;
    const brief = buildBrief({
      role,
      taskNumber: context.number,
      title: context.title,
      repo: context.repo,
      defaultBranch: context.defaultBranch,
      taskBranch,
      docsEntry: config.docs.entry,
      specTemplate: config.docs.specTemplate,
      specVersion: context.task.specVersion,
      spec: context.latestSpec,
      verify: config.verify,
      protectedPaths: config.lanes.red.paths,
      requestThread:
        role === 'spec' || role === 'interviewer' ? await listComments(pool, taskId) : [],
      feedback: builds ? await feedbackSinceLastPush(pool, taskId) : [],
      firstRound,
      prTitlePattern: config.pullRequest.titlePattern,
      chooser,
      questionsAsked,
      standards: role === 'onboarder' ? config.docs.standards : undefined
    });

    const report = await executeRun(deps.agents, {
      role,
      brief,
      session: {
        agentId: agent.externalAgentId,
        agentVersion: agent.version,
        environmentId,
        title: `Officina #${context.number} ${role}`,
        metadata: { task_id: taskId, run_id: runId, role },
        repository: {
          url: `https://github.com/${context.repo}`,
          token,
          // Until the first push the task branch does not exist yet.
          branch: role === 'spec' || firstRound ? context.defaultBranch : taskBranch
        },
        // A conversation is cheap; a lane's build budget would be far too generous for it.
        budgetCents:
          role === 'interviewer'
            ? INTERVIEW_BUDGET_CENTS
            : Math.round(config.lanes[lane].budgetUsd * 100)
      },
      validate: builds
        ? (output) => [
            ...titleProblems(config.pullRequest.titlePattern)(output),
            // The onboarder's contract has no review answer, so only the builder is held to one.
            ...(role === 'builder' ? reviewProblems(githubReviews)(output) : [])
          ]
        : role === 'chooser'
          ? planProblems(gate, new Set(members.map((member) => member.id)))
          : role === 'interviewer'
            ? interviewProblems(questionsAsked)
            : undefined,
      onSessionCreated: (sessionId) => setRunExternalId(pool, runId, sessionId),
      onEvent: (event) => appendRunEvent(pool, runId, event.type, event)
    });

    if (refsBefore) {
      // Checked whatever the run reported: a failed run may still have pushed somewhere.
      const changes = await refChanges(
        deps.github,
        guardedRefs,
        refsBefore,
        await deps.github.refSnapshot(guardedRefs)
      );
      if (changes.length) {
        const reason = `refs outside ${taskBranch} changed during the build: ${changes.join('; ')}`;
        await finishRun(pool, runId, {
          status: 'failed',
          costCents: report.costCents,
          result: { refsChanged: changes, outcome: report.outcome }
        });
        await blockTask(
          pool,
          taskId,
          `While the ${role} ran, ${changes.join('; ')}. The ${role} may only push ${taskBranch}. Check those refs on GitHub and restore them if the ${role} changed them; if a person made the change, answer to run the build again.`
        );
        return { status: 'blocked', reason };
      }
    }

    const outcome = report.outcome;
    if (outcome.kind !== 'result') {
      const reason = describeOutcome(outcome);
      await finishRun(pool, runId, {
        status: 'failed',
        costCents: report.costCents,
        result: outcome
      });
      await blockTask(pool, taskId, `The ${role} agent could not complete its step: ${reason}.`);
      return { status: 'blocked', reason };
    }

    const output = outcome.output;
    let roleOutput: RoleOutput;
    if (builds) {
      const built = output as AgentOutput<'builder' | 'onboarder'>;
      if (built.outcome === 'pushed' && built.branch !== taskBranch) {
        const reason = `it pushed to ${built.branch} instead of ${taskBranch}`;
        await finishRun(pool, runId, {
          status: 'failed',
          costCents: report.costCents,
          result: output
        });
        await blockTask(pool, taskId, `The ${role} agent could not complete its step: ${reason}.`);
        return { status: 'blocked', reason };
      }
      if (built.outcome === 'pushed') {
        const facts = await deps.github.pushFacts({
          ...repoRef,
          base: context.defaultBranch,
          branch: taskBranch
        });
        // The catalog check reads the pages as pushed, so an edit that does not name the new file
        // does not pass for listing it.
        const catalogPages: Record<string, string | null> = {};
        for (const page of catalogPagesToRead(config.docs.standards.catalogs, facts.addedPaths)) {
          catalogPages[page] =
            // At the head the diff was read from, so a later push cannot change what is checked.
            (await deps.github.readFile({ ...repoRef, path: page, branch: facts.headSha }))?.text ??
            null;
        }
        roleOutput = { role, output: built, facts: { ...facts, catalogPages } } as RoleOutput;
      } else {
        roleOutput = { role, output: built } as RoleOutput;
      }
    } else {
      roleOutput = { role, output } as RoleOutput;
    }

    const mapped = commandForOutput(context.task, roleOutput);
    if (!mapped.ok) throw new Error(mapped.error);
    // Recorded before it is applied, so a crash after the apply still leaves what to open the
    // pull request from.
    await recordRunResult(pool, runId, output);

    const applied = await applyCommand(pool, {
      taskId,
      command: mapped.command,
      actor,
      guard: sameWork(context.task),
      onApplied: async (client, task) => {
        if (role === 'interviewer') {
          const interview = output as AgentOutput<'interviewer'>;
          // The thread keeps the whole conversation, so the spec writer and people read it as one.
          const body =
            interview.outcome === 'question'
              ? interview.question
              : [
                  `**Summary.** ${interview.summary}`,
                  `**Done when:**\n${interview.acceptance.map((item) => `- ${item}`).join('\n')}`
                ].join('\n\n');
          await addComment(client, taskId, actor, body);
          if (interview.outcome === 'complete') {
            await setTaskTitle(client, taskId, interview.title);
          }
        }
        if (role === 'spec' && (output as AgentOutput<'spec'>).outcome === 'specced') {
          await saveSpecVersion(client, {
            taskId,
            version: task.specVersion,
            body: (output as Extract<AgentOutput<'spec'>, { outcome: 'specced' }>).spec,
            createdBy: actor
          });
        }
      }
    });
    if (!applied.ok) {
      await finishRun(pool, runId, {
        status: 'failed',
        costCents: report.costCents,
        result: { discarded: applied.error, output }
      });
      return { status: 'discarded', reason: applied.error };
    }

    if (builds && applied.task.stage === 'reviewing' && context.pullRequest === null) {
      const built = output as PushedBuild;
      try {
        const pr = await openTaskPullRequest(pool, deps.github, {
          taskId,
          publicUrl: deps.publicUrl,
          built
        });
        if (pr) await appendRunEvent(pool, runId, 'officina.pull_request_opened', pr);
      } catch (error) {
        // The round is applied; the scheduler opens the pull request from the recorded result.
        await appendRunEvent(pool, runId, 'officina.pull_request_failed', {
          error: (error as Error).message
        });
      }
    }

    const reply = builds && 'reviewReply' in output ? output.reviewReply : undefined;
    if (reply && githubReviews.length > 0 && context.pullRequest !== null) {
      const reviewers = [...new Set(githubReviews.map((review) => `\`${review.by}\``))];
      try {
        await deps.github.commentOnIssue({
          ...repoRef,
          issueNumber: context.pullRequest,
          body: `Answer to the review by ${reviewers.join(', ')}.\n\n${reply}`
        });
      } catch (error) {
        // The round is applied either way; a lost reply must not block the task.
        await appendRunEvent(pool, runId, 'officina.review_reply_failed', {
          error: (error as Error).message
        });
      }
    }

    if (role === 'chooser' && context.pullRequest !== null) {
      await postChecklist(pool, deps.github, {
        taskId,
        ref: repoRef,
        pullRequest: context.pullRequest,
        taskLink: taskLink(deps.publicUrl, context.number),
        result: output
      });
    }

    await finishRun(pool, runId, {
      status: 'succeeded',
      costCents: report.costCents,
      result: output
    });
    return { status: 'applied' };
  } catch (error) {
    const message = (error as Error).message;
    await finishRun(pool, runId, { status: 'failed', costCents: null, result: { error: message } });
    // Blocking stops the scheduler from retrying a step that fails the same way every time;
    // answering the question retries it.
    await blockTask(
      pool,
      taskId,
      `The ${role} step failed unexpectedly: ${message}. Answer this question to retry it.`
    ).catch(() => {});
    throw error;
  }
};

import {
  GUARD_LABELS,
  PERMISSIONS,
  can,
  effectivePolicy,
  guardsInRequest,
  type Blocked,
  type Guard,
  type Member,
  evaluatePolicy,
  findOption,
  optionAnswer,
  parseProjectConfig,
  policyContext,
  type Actor,
  type Command,
  type Gate
} from '@officina/core';
import {
  addComment,
  applyCommand,
  createTask,
  findTaskIdByNumber,
  latestChooserResult,
  listApprovedSubjects,
  listProjectMemberProfiles,
  listProjectMembers,
  listRuns,
  listTaskSummaries,
  loadProjectConfig,
  loadProjectMember,
  loadTask,
  loadTaskContext,
  resolveProjectId,
  resolveProjectMember,
  type StoreError
} from '@officina/db';
import { checklistMarkdown, handInBuild, type HandInPort } from '@officina/engine';
import { GitHubError } from '@officina/github';
import { CONFIDENTIAL, consoleUrl, describeRequirement } from './board';
import type { Pool } from 'pg';

/** A refused task command, with the HTTP status the API answers it with. */
export class TaskCommandError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

const ERROR_TEXT: Record<StoreError, string> = {
  terminal: 'the task is closed',
  wrong_stage: 'the task is not at a stage where that is possible',
  not_allowed: 'you do not have the role needed for that',
  agents_cannot_approve: 'agents cannot approve',
  blocked: 'the task is waiting for an answer first (use task answer)',
  paused: 'the task is paused',
  awaiting_onboarding: 'the project waits for its agent docs to be merged first',
  already_blocked: 'the task already has an open question',
  not_blocked: 'the task has no open question',
  already_paused: 'the task is already paused',
  not_paused: 'the task is not paused',
  no_lane: 'the task has no lane yet',
  no_head: 'nothing has been built yet',
  wip_limit: 'the lane is at its limit of concurrent work',
  agents_cannot_build_lane: 'agents may not build in this lane',
  needs_developer: 'a person with the technical role builds this one; claim it',
  not_planned: 'the approval chooser has not yet decided who approves this; try again shortly',
  stale_head: 'that review is about an earlier version of the change',
  not_found: 'task not found',
  conflict: 'the task changed meanwhile; look at it again and retry',
  invalid_config: "the project's config is invalid"
};

interface Target {
  readonly repo?: string | undefined;
  readonly asEmail?: string | undefined;
}

const resolve = async (pool: Pool, target: Target) => {
  const projectId = await resolveProjectId(pool, target.repo);
  if (!projectId) {
    throw new TaskCommandError(
      target.repo ? `no project for ${target.repo}` : 'several projects exist; pass --repo'
    );
  }
  const memberId = await resolveProjectMember(pool, projectId, target.asEmail);
  if (!memberId) {
    throw new TaskCommandError(
      target.asEmail
        ? `${target.asEmail} is not a member of this project`
        : 'the project has no owner'
    );
  }
  const actor: Actor = { kind: 'member', memberId };
  return { projectId, memberId, actor };
};

/** A person acting on one project, already identified (by a session, or by the CLI's --as). */
export interface ProjectActor {
  readonly projectId: string;
  readonly memberId: string;
}

interface RequestInput {
  readonly title: string;
  readonly request: string;
  /** Skip the interviewer and go straight to triage; the project's config can also turn it off. */
  readonly skipInterview?: boolean | undefined;
}

/**
 * Opens a request: creates the task and records the request text as the first comment. The
 * interviewer then asks follow-up questions before triage, unless it is skipped.
 */
export const createRequest = async (
  pool: Pool,
  input: Target & RequestInput
): Promise<{ number: number; stage: string }> =>
  createRequestAs(pool, {
    ...(await resolve(pool, input)),
    title: input.title,
    request: input.request,
    skipInterview: input.skipInterview
  });

export const createRequestAs = async (
  pool: Pool,
  input: ProjectActor & RequestInput
): Promise<{ number: number; stage: string }> => {
  const { projectId, memberId } = input;
  const actor: Actor = { kind: 'member', memberId };
  // A request starts paid agent runs, so reading the board is not enough to open one.
  const member = await loadProjectMember(pool, projectId, memberId);
  if (!member || !can(member, 'request'))
    throw new TaskCommandError(
      'watchers can read but not open requests; an owner can give the contributor role',
      403
    );
  const config = parseProjectConfig(await loadProjectConfig(pool, projectId));
  const { guards, hold } = guardRequest(config, member, input);
  // The task and the request it carries land together: a task never exists without its request.
  const { task } = await createTask(pool, {
    projectId,
    title: input.title,
    requesterId: memberId,
    request: input.request,
    guards,
    ...(hold ? { hold } : {})
  });
  const { number } = (await loadTaskContext(pool, task.id))!;
  const interview = !input.skipInterview && (!config.ok || config.config.intake.interview);
  if (interview || hold) return { number, stage: task.stage };
  const submitted = await applyCommand(pool, {
    taskId: task.id,
    command: { type: 'submit_request' },
    actor
  });
  if (!submitted.ok) throw new TaskCommandError(ERROR_TEXT[submitted.error]);
  return { number, stage: submitted.task.stage };
};

/**
 * By rule, never a model's reading: words about secrets, access, publishing or the project's
 * confidential terms guard the task from the start. A guarded request from someone who may not
 * decide it is born held, in the same transaction, so nothing moves it before the owner answers.
 */
const guardRequest = (
  config: ReturnType<typeof parseProjectConfig>,
  member: Member,
  input: RequestInput
): { guards: Guard[]; hold: Blocked | undefined } => {
  const guards = guardsInRequest(
    `${input.title}\n${input.request}`,
    config.ok ? config.config.guards.confidentialTerms : []
  );
  return { guards, hold: guards.length && !can(member, 'publish') ? ownerHold(guards) : undefined };
};

/**
 * The question a guarded request waits on, asked of whoever may `publish`. Submitting as is cannot
 * skip it; the owner answers, and the request goes on like any other, or cancels it.
 */
const ownerHold = (guards: readonly Guard[]): Blocked => ({
  question: `This request is about ${guards.map((guard) => GUARD_LABELS[guard]).join(', ')}. Agents never reveal secrets or confidential content, and never publish, deploy or change access on their own. The owner decides: answer to let the work go on, or cancel it.`,
  askedOf: { role: PERMISSIONS.publish }
});

/** A member's comment on a task's conversation; watchers read but do not comment. */
export const commentAs = async (
  pool: Pool,
  input: ProjectActor & { readonly number: number; readonly text: string }
): Promise<void> => {
  const member = await loadProjectMember(pool, input.projectId, input.memberId);
  if (!member || !can(member, 'comment'))
    throw new TaskCommandError('watchers can read but not comment', 403);
  const taskId = await findTaskIdByNumber(pool, input.projectId, input.number);
  if (!taskId) throw new TaskCommandError('task not found', 404);
  await addComment(pool, taskId, { kind: 'member', memberId: input.memberId }, input.text);
};

export type TaskAction =
  | { readonly type: 'submit' }
  | { readonly type: 'accept' }
  | { readonly type: 'claim' }
  | { readonly type: 'approve' }
  | { readonly type: 'changes'; readonly note: string }
  /** With `option`, the letter of an option the question offers, and `text` an optional note. */
  | { readonly type: 'answer'; readonly text: string; readonly option?: string | undefined }
  | { readonly type: 'cancel'; readonly reason: string }
  | { readonly type: 'decline'; readonly reason: string };

const toCommand = (action: TaskAction): Command => {
  switch (action.type) {
    case 'submit':
      return { type: 'submit_request' };
    case 'accept':
    case 'claim':
    case 'approve':
      return { type: action.type };
    case 'changes':
      return { type: 'request_changes', note: action.note };
    case 'answer':
      return { type: 'answer', text: action.text };
    case 'cancel':
    case 'decline':
      return { type: action.type, reason: action.reason };
  }
};

/**
 * The answer as the thread keeps it. A picked option is written out by its letter and label, and
 * holds only for the task version it was read from, so a question asked meanwhile, even with the
 * same words, is never answered by it.
 */
const resolveAnswer = async (
  pool: Pool,
  taskId: string,
  action: TaskAction
): Promise<{ action: TaskAction; expectedVersion?: number }> => {
  if (action.type !== 'answer') return { action };
  if (action.option === undefined) {
    if (!action.text.trim()) throw new TaskCommandError('write an answer or pick an option', 400);
    return { action };
  }
  const stored = await loadTask(pool, taskId);
  const option = findOption(stored?.task.blocked?.options, action.option);
  if (!stored || !option) throw new TaskCommandError('the open question offers no such option');
  return {
    action: { type: 'answer', text: optionAnswer(action.option, option, action.text) },
    expectedVersion: stored.version
  };
};

/** Applies one person's decision to a task, as that person. */
export const actOnTask = async (
  pool: Pool,
  input: Target & { readonly number: number; readonly action: TaskAction }
): Promise<{ stage: string; satisfied?: boolean }> =>
  actOnTaskAs(pool, {
    ...(await resolve(pool, input)),
    number: input.number,
    action: input.action
  });

export const actOnTaskAs = async (
  pool: Pool,
  input: ProjectActor & { readonly number: number; readonly action: TaskAction }
): Promise<{ stage: string; satisfied?: boolean }> => {
  const { projectId } = input;
  const actor: Actor = { kind: 'member', memberId: input.memberId };
  const taskId = await findTaskIdByNumber(pool, projectId, input.number);
  if (!taskId) throw new TaskCommandError(`task #${input.number} not found`);
  const { action, expectedVersion } = await resolveAnswer(pool, taskId, input.action);
  const result = await applyCommand(pool, {
    taskId,
    command: toCommand(action),
    actor,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    // In the same transaction as the decision: someone not allowed to answer leaves no comment.
    onApplied: async (client) => {
      if (action.type === 'answer') await addComment(client, taskId, actor, action.text);
    }
  });
  if (!result.ok) throw new TaskCommandError(ERROR_TEXT[result.error]);
  const recorded = result.events.find((event) => event.type === 'approval_recorded');
  return {
    stage: result.task.stage,
    ...(recorded && recorded.type === 'approval_recorded' ? { satisfied: recorded.satisfied } : {})
  };
};

/** What a developer hands in with the build they pushed. */
export interface HandInInput {
  readonly number: number;
  readonly prTitle: string;
  readonly verified: readonly string[];
  readonly notVerified: readonly string[];
}

/**
 * A developer hands in the build they claimed and pushed to the task branch, by hand or with their
 * own agents: Officina reads the push from GitHub and sends it to the same review an agent's gets.
 */
export const handInAs = async (
  pool: Pool,
  github: HandInPort | undefined,
  input: ProjectActor & HandInInput & { readonly publicUrl: string }
): Promise<{ stage: string; pullRequest: number | null }> => {
  if (!github) throw new TaskCommandError('the GitHub App is not configured', 503);
  const taskId = await findTaskIdByNumber(pool, input.projectId, input.number);
  if (!taskId) throw new TaskCommandError(`task #${input.number} not found`, 404);
  try {
    const result = await handInBuild(
      { pool, github, publicUrl: input.publicUrl },
      { ...input, taskId }
    );
    if (result.ok) return { stage: result.stage, pullRequest: result.pullRequest };
    throw new TaskCommandError(
      result.error === 'bad_title'
        ? result.problems.join('; ')
        : result.error === 'not_installed'
          ? 'the GitHub App is not installed on this repository'
          : ERROR_TEXT[result.error]
    );
  } catch (error) {
    if (error instanceof GitHubError)
      throw new TaskCommandError(
        `could not read the task branch on GitHub; push it first (${error.message})`
      );
    throw error;
  }
};

const money = (cents: number | null) =>
  cents === null ? 'cost unknown' : `$${(cents / 100).toFixed(2)}`;

const NEXT_STEP: Partial<Record<string, string>> = {
  request: 'the interviewer is reading the request; to skip it: task submit --number {n}',
  triage: 'task accept --number {n}   (or: task decline --number {n} --reason "...")',
  speccing: 'an agent is writing the spec; check back with task show',
  spec_review:
    'read the spec, then: task approve --number {n}   (or: task changes --number {n} --note "...")',
  ready: 'waiting for a free build slot; the engine dispatches it automatically',
  building: 'an agent is building it; check back with task show',
  reviewing: 'two agents are reviewing it; check back with task show',
  choosing: 'an agent is preparing the verification checklist',
  verifying:
    'check the pull request, then: task approve --number {n}   (or: task changes --number {n} --note "...")',
  merging: 'approve and merge the pull request on GitHub; the task closes itself',
  done: 'nothing: the task is done',
  declined: 'nothing: the task was declined',
  cancelled: 'nothing: the task was cancelled'
};

/** A human-readable status of one task: where it is, what it waits for, and what to do next. */
export const describeTask = async (
  pool: Pool,
  input: Target & { readonly number: number; readonly consoleWorkspace?: string | undefined }
): Promise<string> => {
  const { projectId, memberId } = await resolve(pool, input);
  const taskId = await findTaskIdByNumber(pool, projectId, input.number);
  if (!taskId) throw new TaskCommandError(`task #${input.number} not found`);
  const context = (await loadTaskContext(pool, taskId))!;
  const viewer = await loadProjectMember(pool, projectId, memberId);
  const { task } = context;
  // As on the board: a confidential task's words only for members who may see them.
  const reads =
    !task.guards.includes('confidential') || (viewer !== null && can(viewer, 'see_confidential'));
  const shown = (text: string) => (reads ? text : CONFIDENTIAL);
  const lines = [
    `Task #${context.number}: ${context.title}`,
    `Stage: ${task.stage}   Lane: ${task.lane ?? 'not set yet'}   User-visible: ${task.userVisible ? 'yes' : 'no'}${task.paused ? '   PAUSED' : ''}`
  ];

  if (task.blocked) {
    const who =
      'memberId' in task.blocked.askedOf ? 'a specific member' : `a ${task.blocked.askedOf.role}`;
    lines.push('', `BLOCKED, question for ${who}:`, `  ${shown(task.blocked.question)}`);
  }

  if ((task.stage === 'spec_review' || task.stage === 'verifying') && task.lane) {
    const config = parseProjectConfig(context.rawConfig);
    if (config.ok) {
      const gate: Gate = task.stage;
      const subject = gate === 'spec_review' ? `spec:${task.specVersion}` : `sha:${task.headSha}`;
      const plan = task.approvalPlans[gate];
      const names = new Map(
        (await listProjectMemberProfiles(pool, projectId)).map((member) => [member.id, member.name])
      );
      if (plan?.subject !== subject) {
        lines.push('', 'Waiting for the approval chooser to decide who approves.');
      } else {
        lines.push(
          '',
          `Approval plan: check depth ${plan.depth}. ${shown(plan.rationale)}`,
          ...plan.extra.map(
            (item) => `  also needs ${describeRequirement(item.requirement)}: ${shown(item.reason)}`
          ),
          ...plan.verifiers.map(
            (verifier) =>
              `  asks ${names.get(verifier.memberId) ?? 'a former member'} to verify: ${shown(verifier.reason)}`
          )
        );
      }
      const result = evaluatePolicy(
        effectivePolicy(config.config, task, gate),
        await listApprovedSubjects(pool, taskId),
        policyContext(config.config, task, gate, {
          members: await listProjectMembers(pool, projectId),
          subject
        })
      );
      lines.push(
        '',
        `Approval needed from: ${result.pending.map(describeRequirement).join(', ') || 'nobody (satisfied)'}`
      );
      if (result.waived.length) {
        lines.push(
          `Waived (nobody holds the role yet): ${result.waived.map(describeRequirement).join(', ')}`
        );
      }
    }
  }

  if (context.pullRequest && reads)
    lines.push('', `Pull request: https://github.com/${context.repo}/pull/${context.pullRequest}`);
  const checklist = checklistMarkdown(
    await latestChooserResult(pool, taskId),
    `task ${context.number}`
  );
  if (checklist) lines.push('', shown(checklist));
  if (context.latestSpec)
    lines.push('', `Spec, version ${task.specVersion}:`, '', shown(context.latestSpec));

  // Runs quote the code and carry costs: like the board, only for members with `see_runs`.
  const runs = viewer && can(viewer, 'see_runs') ? await listRuns(pool, taskId) : [];
  if (runs.length) {
    lines.push('', 'Agent runs:');
    for (const run of runs) {
      const url = consoleUrl(input.consoleWorkspace, run.sessionId);
      const link = url ? `   ${url}` : '';
      lines.push(
        `  ${run.role.padEnd(21)} ${run.status.padEnd(10)} ${money(run.costCents)}${link}`
      );
    }
  }

  const next = task.blocked
    ? 'task answer --number {n} --text "..."'
    : task.paused
      ? 'the task is paused'
      : (NEXT_STEP[task.stage] ?? '');
  lines.push('', `Next: ${next.replaceAll('{n}', String(context.number))}`);
  return lines.join('\n');
};

export const listTasksText = async (pool: Pool, target: Target): Promise<string> => {
  const { projectId } = await resolve(pool, target);
  const tasks = await listTaskSummaries(pool, projectId);
  if (!tasks.length)
    return 'No tasks yet. Start one with: task create --title "..." --request "..."';
  return tasks
    .map(
      (task) =>
        `#${String(task.number).padEnd(4)} ${task.stage.padEnd(12)} ${(task.lane ?? '-').padEnd(9)} ${task.blocked ? 'BLOCKED ' : ''}${task.title}`
    )
    .join('\n');
};

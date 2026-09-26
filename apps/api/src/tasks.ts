import {
  evaluatePolicy,
  parseProjectConfig,
  type Actor,
  type Command,
  type Gate,
  type Requirement
} from '@officina/core';
import {
  addComment,
  applyCommand,
  createTask,
  findTaskIdByNumber,
  listApprovedSubjects,
  listProjectMembers,
  listRuns,
  listTaskSummaries,
  loadTaskContext,
  resolveProjectId,
  resolveProjectMember,
  type StoreError
} from '@officina/db';
import type { Pool } from 'pg';

export class TaskCommandError extends Error {}

const ERROR_TEXT: Record<StoreError, string> = {
  terminal: 'the task is closed',
  wrong_stage: 'the task is not at a stage where that is possible',
  not_allowed: 'you do not have the role needed for that',
  agents_cannot_approve: 'agents cannot approve',
  blocked: 'the task is waiting for an answer first (use task answer)',
  paused: 'the task is paused',
  already_blocked: 'the task already has an open question',
  not_blocked: 'the task has no open question',
  already_paused: 'the task is already paused',
  not_paused: 'the task is not paused',
  no_lane: 'the task has no lane yet',
  no_head: 'nothing has been built yet',
  wip_limit: 'the lane is at its limit of concurrent work',
  agents_cannot_build_lane: 'agents may not build in this lane',
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

/** Opens a request: creates the task, records the request text as the first comment, submits it. */
export const createRequest = async (
  pool: Pool,
  input: Target & { readonly title: string; readonly request: string }
): Promise<{ number: number; stage: string }> => {
  const { projectId, memberId, actor } = await resolve(pool, input);
  const { task } = await createTask(pool, { projectId, title: input.title, requesterId: memberId });
  await addComment(pool, task.id, actor, input.request);
  const submitted = await applyCommand(pool, {
    taskId: task.id,
    command: { type: 'submit_request' },
    actor
  });
  if (!submitted.ok) throw new TaskCommandError(ERROR_TEXT[submitted.error]);
  const number = (
    await pool.query<{ number: number }>('select number from tasks where id = $1', [task.id])
  ).rows[0]!.number;
  return { number, stage: submitted.task.stage };
};

export type TaskAction =
  | { readonly type: 'accept' }
  | { readonly type: 'approve' }
  | { readonly type: 'changes'; readonly note: string }
  | { readonly type: 'answer'; readonly text: string }
  | { readonly type: 'cancel'; readonly reason: string }
  | { readonly type: 'decline'; readonly reason: string };

const toCommand = (action: TaskAction): Command => {
  switch (action.type) {
    case 'accept':
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

/** Applies one person's decision to a task, as that person. */
export const actOnTask = async (
  pool: Pool,
  input: Target & { readonly number: number; readonly action: TaskAction }
): Promise<{ stage: string; satisfied?: boolean }> => {
  const { projectId, actor } = await resolve(pool, input);
  const taskId = await findTaskIdByNumber(pool, projectId, input.number);
  if (!taskId) throw new TaskCommandError(`task #${input.number} not found`);
  if (input.action.type === 'answer') await addComment(pool, taskId, actor, input.action.text);
  const result = await applyCommand(pool, { taskId, command: toCommand(input.action), actor });
  if (!result.ok) throw new TaskCommandError(ERROR_TEXT[result.error]);
  const recorded = result.events.find((event) => event.type === 'approval_recorded');
  return {
    stage: result.task.stage,
    ...(recorded && recorded.type === 'approval_recorded' ? { satisfied: recorded.satisfied } : {})
  };
};

const money = (cents: number | null) =>
  cents === null ? 'cost unknown' : `$${(cents / 100).toFixed(2)}`;

const article = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

const describeRequirement = (requirement: Requirement): string =>
  'role' in requirement
    ? article(requirement.role)
    : 'domain' in requirement
      ? article(`${requirement.domain} approver`)
      : 'the requester';

const NEXT_STEP: Partial<Record<string, string>> = {
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
  const { projectId } = await resolve(pool, input);
  const taskId = await findTaskIdByNumber(pool, projectId, input.number);
  if (!taskId) throw new TaskCommandError(`task #${input.number} not found`);
  const context = (await loadTaskContext(pool, taskId))!;
  const { task } = context;
  const lines = [
    `Task #${context.number}: ${context.title}`,
    `Stage: ${task.stage}   Lane: ${task.lane ?? 'not set yet'}   User-visible: ${task.userVisible ? 'yes' : 'no'}${task.paused ? '   PAUSED' : ''}`
  ];

  if (task.blocked) {
    const who =
      'memberId' in task.blocked.askedOf ? 'a specific member' : `a ${task.blocked.askedOf.role}`;
    lines.push('', `BLOCKED, question for ${who}:`, `  ${task.blocked.question}`);
  }

  if ((task.stage === 'spec_review' || task.stage === 'verifying') && task.lane) {
    const config = parseProjectConfig(context.rawConfig);
    if (config.ok) {
      const gate: Gate = task.stage;
      const subject = gate === 'spec_review' ? `spec:${task.specVersion}` : `sha:${task.headSha}`;
      const result = evaluatePolicy(
        config.config.lanes[task.lane].approvals[gate],
        await listApprovedSubjects(pool, taskId),
        {
          members: await listProjectMembers(pool, projectId),
          requesterId: task.requesterId,
          userVisible: task.userVisible,
          subject
        }
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

  if (context.pullRequest)
    lines.push('', `Pull request: https://github.com/${context.repo}/pull/${context.pullRequest}`);
  if (context.latestSpec)
    lines.push('', `Spec, version ${task.specVersion}:`, '', context.latestSpec);

  const runs = await listRuns(pool, taskId);
  if (runs.length) {
    lines.push('', 'Agent runs:');
    for (const run of runs) {
      const link =
        run.sessionId && input.consoleWorkspace
          ? `   https://platform.claude.com/workspaces/${input.consoleWorkspace}/sessions/${run.sessionId}`
          : '';
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

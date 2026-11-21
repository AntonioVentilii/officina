import {
  TERMINAL_STAGES,
  can,
  guardsAddedBy,
  guardsInRequest,
  mergedEarlyText,
  ownerHold,
  readsTask,
  type Blocked,
  type Guard,
  type Member,
  findOption,
  memberActor,
  optionAnswer,
  parseProjectConfig,
  type Actor,
  type ApprovalPlan,
  type Command,
  type ConnectedApp,
  type LinkProblem,
  type Task
} from '@officina/core';
import {
  addComment,
  applyCommand,
  applyCommandIn,
  lockTaskLinks,
  openSplitSubtasks,
  buildRunInProgress,
  findRequestedTask,
  findTaskIdByNumber,
  inTransaction,
  insertTask,
  latestChooserResult,
  listProjectMemberProfiles,
  listProjectMembers,
  listRuns,
  listTaskEvents,
  listTaskSummaries,
  loadProjectConfig,
  loadProjectMember,
  loadTask,
  loadTaskContext,
  lockProjectConfig,
  nameRequestedTask,
  resolveProjectId,
  resolveProjectMember,
  setTaskLinks,
  type StoreError,
  handInUnderWay
} from '@officina/db';
import { handInBuild, type HandInPort } from '@officina/engine';
import { GitHubError } from '@officina/github';
import {
  allowanceText,
  allowanceView,
  approvalState,
  askedOfLabel,
  buildWaitLabel,
  CONFIDENTIAL,
  consoleUrl,
  describeRequirement,
  optionsFor,
  optionText,
  questionFor,
  readyWait,
  tasksInWords,
  type ApprovalState
} from './board';
import { checklistLines, checklistView, type ChosenChecklist } from './checklist-view';
import { reviewFindingsFor, reviewLines, SENT_BACK } from './review-findings';
import type { Pool, PoolClient } from 'pg';

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
  awaiting_tasks: 'the task waits for other tasks to be merged first; task show says which',
  split_proposed: 'its spec proposes a split into sub-tasks, which is not approved as a spec',
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
  invalid_config: "the project's config is invalid",
  confirm_on_board:
    'an approval through a connected app is only a proposal; confirm it on the board',
  no_proposal: 'no approval proposed for you is waiting on this task',
  merged_early: 'its pull request was already merged on GitHub; close the task as done or cancel it'
};

const LINK_PROBLEM_TEXT: Record<LinkProblem, string> = {
  self: 'a task cannot be its own parent or wait for itself',
  task_started: 'links change only until the task is ready; this one is already past it',
  parent_started:
    'the parent is already past ready; a task is linked to a parent before it is built',
  nested: 'sub-tasks go one level deep: the parent has a parent, or the task has sub-tasks itself',
  dependency_closed: 'a task cannot wait for a task that was cancelled or declined',
  cycle: 'these links would make the tasks wait for each other forever'
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
  /** The connected app acting for the member, recorded on what it does; absent on the board. */
  readonly via?: ConnectedApp | undefined;
}

const actorOf = (input: ProjectActor): Actor => memberActor(input.memberId, input.via);

interface RequestInput {
  readonly title: string;
  readonly request: string;
  /** Skip the interviewer and go straight to triage; the project's config can also turn it off. */
  readonly skipInterview?: boolean | undefined;
  /**
   * The client's name for this request, the same each time it sends it again: a repeat from the
   * same person finds the task the first one opened, rather than opening and interviewing twice.
   */
  readonly requestId?: string | undefined;
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
    skipInterview: input.skipInterview,
    requestId: input.requestId
  });

export const createRequestAs = async (
  pool: Pool,
  input: ProjectActor & RequestInput
): Promise<{ number: number; stage: string }> => {
  const { projectId, memberId } = input;
  const actor = actorOf(input);
  // A request starts paid agent runs, so reading the board is not enough to open one.
  const member = await loadProjectMember(pool, projectId, memberId);
  if (!member || !can(member, 'request'))
    throw new TaskCommandError(
      'watchers can read but not open requests; an owner can give the contributor role',
      403
    );
  // The task, its request and a skipped interview land together, and all of them are decided
  // from one read of the config, taken under the project's lock: a task never exists without its
  // request, and one that skips the interviewer is never seen waiting for it. The same lock makes
  // a repeat of this request wait for the first and then find its task.
  const opened = await inTransaction(pool, async (client) => {
    const config = parseProjectConfig(await lockProjectConfig(client, projectId));
    const before = await openedBefore(client, input);
    if (before) return before;
    const { guards, hold } = guardRequest(config, member, input);
    const { task } = await insertTask(client, {
      projectId,
      title: input.title,
      requesterId: memberId,
      via: input.via,
      request: input.request,
      guards,
      ...(hold ? { hold } : {})
    });
    if (input.requestId) await nameRequestedTask(client, task.id, input.requestId);
    const interview = !input.skipInterview && (!config.ok || config.config.intake.interview);
    if (interview || hold) return task;
    const submitted = await applyCommandIn(client, {
      taskId: task.id,
      command: { type: 'submit_request' },
      actor
    });
    if (!submitted.ok) throw new TaskCommandError(ERROR_TEXT[submitted.error]);
    return submitted.task;
  });
  const { number } = (await loadTaskContext(pool, opened.id))!;
  return { number, stage: opened.stage };
};

/** The task an earlier send of this same request opened, when the client named the request. */
const openedBefore = (client: PoolClient, input: ProjectActor & RequestInput) =>
  input.requestId
    ? findRequestedTask(client, {
        projectId: input.projectId,
        requesterId: input.memberId,
        requestId: input.requestId
      })
    : null;

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
 * Writes a member's comment. Words that guard the task by the request's rule apply that guard in the
 * same transaction; words that guard nothing new, or a closed task nothing runs on any more, change
 * no task.
 */
const writeComment = async (
  pool: Pool,
  input: ProjectActor & { readonly taskId: string; readonly task: Task; readonly text: string }
): Promise<void> => {
  const actor = actorOf(input);
  const config = parseProjectConfig(await loadProjectConfig(pool, input.projectId));
  const guards = config.ok ? guardsAddedBy(input.task, config.config, input.text) : [];
  if (TERMINAL_STAGES.has(input.task.stage) || !guards.length) {
    await addComment(pool, input.taskId, actor, input.text);
    return;
  }
  const result = await applyCommand(pool, {
    taskId: input.taskId,
    command: { type: 'guard_words', text: input.text },
    actor,
    onApplied: (client) => addComment(client, input.taskId, actor, input.text)
  });
  if (!result.ok) throw new TaskCommandError(ERROR_TEXT[result.error]);
};

/** A member's comment on a task's conversation; watchers read but do not comment. */
export const commentAs = async (
  pool: Pool,
  input: ProjectActor & { readonly number: number; readonly text: string }
): Promise<void> => {
  const member = await loadProjectMember(pool, input.projectId, input.memberId);
  if (!member || !can(member, 'comment'))
    throw new TaskCommandError('watchers can read but not comment', 403);
  const taskId = await findTaskIdByNumber(pool, input.projectId, input.number);
  const stored = taskId ? await loadTask(pool, taskId) : null;
  if (!taskId || !stored) throw new TaskCommandError('task not found', 404);
  if (!readsTask(member, stored.task))
    throw new TaskCommandError('only members who may read this task can comment on it', 403);
  await writeComment(pool, { ...input, taskId, task: stored.task });
};

export type TaskAction =
  | { readonly type: 'submit' }
  | { readonly type: 'accept' }
  | { readonly type: 'claim' }
  | { readonly type: 'release' }
  | { readonly type: 'approve' }
  | { readonly type: 'propose_approval' }
  | { readonly type: 'discard_proposal' }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'changes'; readonly note: string }
  | { readonly type: 'keep_whole' }
  /**
   * With `option`, the letter of an option the question offers, `version` the task version the
   * question was read at, and `text` an optional note.
   */
  | {
      readonly type: 'answer';
      readonly text: string;
      readonly option?: string | undefined;
      readonly version?: number | undefined;
    }
  | { readonly type: 'cancel'; readonly reason: string }
  | { readonly type: 'decline'; readonly reason: string }
  | { readonly type: 'close_merged'; readonly reason: string };

const toCommand = (action: TaskAction): Command => {
  switch (action.type) {
    case 'submit':
      return { type: 'submit_request' };
    case 'changes':
      return { type: 'request_changes', note: action.note };
    case 'answer':
      return {
        type: 'answer',
        text: action.text,
        ...(action.option === undefined ? {} : { option: action.option })
      };
    case 'cancel':
    case 'decline':
    case 'close_merged':
      return { type: action.type, reason: action.reason };
    // The rest carry nothing but the command they name.
    default:
      return { type: action.type };
  }
};

const QUESTION_CHANGED =
  'the task changed since you read this question; look at it again and choose again';

/** The option picked from the question as the person read it, refused once the task moved on. */
const pickedOption = async (
  pool: Pool,
  taskId: string,
  key: string,
  version: number | undefined
) => {
  if (version === undefined)
    throw new TaskCommandError(
      'a picked option needs the version of the question it was read at',
      400
    );
  const stored = await loadTask(pool, taskId);
  if (stored && stored.version !== version) throw new TaskCommandError(QUESTION_CHANGED);
  const option = findOption(stored?.task.blocked?.options, key);
  if (!option) throw new TaskCommandError('the open question offers no such option');
  return { option, version };
};

/**
 * The answer as the thread keeps it. A picked option is written out by its letter and label, and
 * holds only for the task version the person read the question at, so a question asked meanwhile,
 * even with the same words, is never answered by it.
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
  const { option, version } = await pickedOption(pool, taskId, action.option, action.version);
  return {
    // The letter goes on with the answer: the size check's own option grants what it offers.
    action: {
      type: 'answer',
      text: optionAnswer(action.option, option, action.text),
      option: action.option
    },
    expectedVersion: version
  };
};

/**
 * A build is handed back only once no agent run is left on it: the scheduler stops a run taken over
 * from the agent on its next pass, and a run still going when the build is handed back would no
 * longer count as taken over, so its result could land once the agent is given the build again.
 */
const refuseWhileAgentRuns = async (client: PoolClient, taskId: string) => {
  if (await buildRunInProgress(client, taskId))
    throw new TaskCommandError(
      "the agent's run on this build is still being stopped; hand it back again in a minute"
    );
};

/** No decision changes a task while a build is being handed in on it, from any board or the CLI. */
const refuseWhileHandingIn = async (client: PoolClient, taskId: string) => {
  if (await handInUnderWay(client, taskId))
    throw new TaskCommandError('this build is being handed in; wait for it to finish');
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
  const actor = actorOf(input);
  const taskId = await findTaskIdByNumber(pool, projectId, input.number);
  if (!taskId) throw new TaskCommandError(`task #${input.number} not found`);
  const { action, expectedVersion } = await resolveAnswer(pool, taskId, input.action);
  const result = await inTransaction(pool, async (client) => {
    // Approving a split links its sub-tasks under the task's row lock, so the project's link
    // lock comes first, in the order every link change takes them.
    if (action.type === 'approve') await lockTaskLinks(client, projectId);
    return applyCommandIn(client, {
      taskId,
      command: toCommand(action),
      actor,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      // In the same transaction as the decision: someone not allowed to answer leaves no comment, and
      // a build is not handed back while an agent's run on it is still being stopped.
      onApplied: async (client, after) => {
        await refuseWhileHandingIn(client, taskId);
        if (action.type === 'release') await refuseWhileAgentRuns(client, taskId);
        if (action.type === 'answer') await addComment(client, taskId, actor, action.text);
        // An approval that moves a proposed split on approved the split: its sub-tasks open with it.
        if (action.type === 'approve' && after.stage === 'ready' && after.splitProposed)
          await openSplitSubtasks(client, { taskId, actor });
      }
    });
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
  /** Required in the sections of the project's pull request template when it names one. */
  readonly prBody?: string | undefined;
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
      result.error === 'bad_pull_request'
        ? result.problems.join('; ')
        : result.error === 'not_installed'
          ? 'the GitHub App is not installed on this repository'
          : result.error === 'handing_in'
            ? 'this build is being handed in; wait for it to finish'
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

/** A developer's hand-in from the CLI, as the member `--as` names (the project owner by default). */
export const handIn = async (
  pool: Pool,
  github: HandInPort | undefined,
  input: Target & HandInInput & { readonly publicUrl: string }
): Promise<{ stage: string; pullRequest: number | null }> =>
  handInAs(pool, github, { ...input, ...(await resolve(pool, input)) });

/** A task's links in one line, as `task link` prints them. */
const linkSummary = (number: number, parent: number | undefined, after: readonly number[]) => {
  const waited = [...new Set(after)].sort((a, b) => a - b);
  const parts = [
    ...(parent === undefined ? [] : [`parent task ${parent}`]),
    ...(waited.length ? [`waits for ${tasksInWords(waited)}`] : [])
  ];
  return `Task #${number}: ${parts.join(', ') || 'no links'}.`;
};

/**
 * Sets a task's parent and the tasks it waits for, replacing its earlier links; with neither, it
 * removes them. Only who may triage links tasks, and only before they are built.
 */
export const linkTask = async (
  pool: Pool,
  input: Target & {
    readonly number: number;
    readonly parent?: number | undefined;
    readonly after: readonly number[];
  }
): Promise<string> => {
  const { projectId, memberId, actor } = await resolve(pool, input);
  const member = await loadProjectMember(pool, projectId, memberId);
  if (!member || !can(member, 'triage'))
    throw new TaskCommandError('only maintainers and owners link tasks', 403);
  const idOf = async (number: number) => {
    const id = await findTaskIdByNumber(pool, projectId, number);
    if (!id) throw new TaskCommandError(`task #${number} not found`, 404);
    return id;
  };
  const taskId = await idOf(input.number);
  const parentId = input.parent === undefined ? null : await idOf(input.parent);
  const after = await Promise.all(input.after.map(idOf));
  const { problem } = await inTransaction(pool, (client) =>
    setTaskLinks(client, { projectId, taskId, parentId, after, actor })
  );
  if (problem) throw new TaskCommandError(LINK_PROBLEM_TEXT[problem]);
  return linkSummary(input.number, input.parent, input.after);
};

/** What an agent wrote, set off from Officina's own words in the terminal. */
const indent = (text: string) =>
  text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');

const money = (cents: number | null) =>
  cents === null ? 'cost unknown' : `$${(cents / 100).toFixed(2)}`;

const NEXT_STEP: Partial<Record<string, string>> = {
  request: 'the interviewer is reading the request; to skip it: task submit --number {n}',
  triage: 'task accept --number {n}   (or: task decline --number {n} --reason "...")',
  speccing: 'an agent is writing the spec; check back with task show',
  spec_review:
    'read the spec, then: task approve --number {n}   (or: task changes --number {n} --note "...")',
  split_review:
    'read the proposed split, then: task approve --number {n} to open its sub-tasks   (or: task changes --number {n} --note "..."; to keep it as one task, use the board or Claude)',
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

/** The approval plan of the task's gate and who must still approve, for `describeTask`. */
const approvalLines = (
  approval: ApprovalState,
  plan: ApprovalPlan | undefined,
  names: ReadonlyMap<string, string>,
  /** The task's words as this viewer may read them (a confidential task hides them). */
  shown: (text: string) => string
): string[] => {
  if (!approval.planned) return ['', 'Waiting for the approval chooser to decide who approves.'];
  const needed = [
    `Approval needed from: ${approval.pending.map(describeRequirement).join(', ') || 'nobody (satisfied)'}`,
    ...(approval.waived.length
      ? [
          `Waived (nobody holds the role yet): ${approval.waived.map(describeRequirement).join(', ')}`
        ]
      : [])
  ];
  // A proposed split has no approval plan: the lane's policy says who decides on it.
  if (!plan) return ['', 'A proposed split: approving it opens its sub-tasks.', ...needed];
  return [
    '',
    `Approval plan: check depth ${plan.depth}. ${shown(plan.rationale)}`,
    ...plan.extra.map(
      (item) => `  also needs ${describeRequirement(item.requirement)}: ${shown(item.reason)}`
    ),
    ...plan.verifiers.map(
      (verifier) =>
        `  asks ${names.get(verifier.memberId) ?? 'a former member'} to verify: ${shown(verifier.reason)}`
    ),
    '',
    ...needed
  ];
};

/** The open question for `describeTask`: who it is for, its words, then each option by letter. */
const blockedLines = (
  blocked: Blocked,
  viewer: Member,
  names: ReadonlyMap<string, string>,
  reads: boolean
): string[] => [
  '',
  `BLOCKED, question for ${askedOfLabel(blocked.askedOf, names)}:`,
  `  ${reads ? questionFor(viewer, blocked) : CONFIDENTIAL}`,
  ...(reads ? optionsFor(viewer, blocked) : []).map((option) => `  ${optionText(option)}`)
];

/** How to answer the open question: in words, or by an option at the version it was read at. */
const answerHint = (blocked: Blocked, version: number): string =>
  blocked.options?.length
    ? `task answer --number {n} --option <letter> --version ${version}   (or: task answer --number {n} --text "...")`
    : 'task answer --number {n} --text "..."';

/** What a task whose pull request merged early waits for, which no CLI command does. */
const CLOSE_MERGED_HINT = 'close the task as done with a reason on the board, or cancel it';

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
  if (!viewer) throw new TaskCommandError('you are not a member of this project');
  const { task } = context;
  // As on the board: a confidential task's words only for members who may see them.
  const reads = readsTask(viewer, task);
  const shown = (text: string) => (reads ? text : CONFIDENTIAL);
  const lines = [
    `Task #${context.number}: ${context.title}`,
    `Stage: ${task.stage}   Lane: ${task.lane ?? 'not set yet'}   User-visible: ${task.userVisible ? 'yes' : 'no'}${task.paused ? '   PAUSED' : ''}`
  ];

  const names = new Map(
    (await listProjectMemberProfiles(pool, projectId)).map((member) => [member.id, member.name])
  );
  if (task.mergedEarly) lines.push('', shown(mergedEarlyText(task.mergedEarly)));
  if (task.blocked) lines.push(...blockedLines(task.blocked, viewer, names, reads));
  const allowance = allowanceView(task, await listTaskEvents(pool, taskId), names);
  if (allowance) lines.push('', allowanceText(allowance));

  const approval = await approvalState(pool, task, {
    members: await listProjectMembers(pool, projectId),
    names,
    rawConfig: context.rawConfig
  });
  if (approval)
    lines.push(...approvalLines(approval, task.approvalPlans[approval.gate], names, shown));

  if (context.pullRequest && reads)
    lines.push('', `Pull request: https://github.com/${context.repo}/pull/${context.pullRequest}`);
  const checklist = await checklistView(pool, {
    taskId,
    task,
    viewer,
    chosen: (await latestChooserResult(pool, taskId)) as ChosenChecklist | null
  });
  if (checklist?.checklist.length)
    lines.push(
      '',
      ...(reads ? checklistLines(checklist, 'Checklist:') : ['Checklist:', CONFIDENTIAL])
    );
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

  const reviews = await reviewFindingsFor(pool, viewer, { ...task, id: taskId });
  if (reviews?.latest) lines.push('', ...reviewLines(reviews, indent));

  const wait = await readyWait(pool, { id: taskId, stage: task.stage });
  const next =
    task.mergedEarly && task.blocked
      ? CLOSE_MERGED_HINT
      : task.blocked
        ? answerHint(task.blocked, context.version)
        : task.paused
          ? 'the task is paused'
          : reviews?.sentBack
            ? SENT_BACK
            : wait
              ? buildWaitLabel(wait)
              : (NEXT_STEP[
                  task.splitProposed && task.stage === 'spec_review' ? 'split_review' : task.stage
                ] ?? '');
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

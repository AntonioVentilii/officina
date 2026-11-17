import {
  CHECK_CHANNEL_LABELS,
  CHECK_OUTCOME_LABELS,
  checkCounts,
  checklistHead,
  ENGINE,
  latestChecks,
  type Task
} from '@officina/core';
import {
  appendTaskEvent,
  claimChecklistComment,
  hasTaskEvent,
  latestChooserResult,
  listChecks,
  listVerifyingDecisions,
  loadChecklistComment,
  loadTaskContext,
  saveChecklistComment,
  type ChecklistCommentRow,
  type RecordedCheck,
  type VerifyingDecision
} from '@officina/db';
import type { GitHubClient, RepoRef } from '@officina/github';
import type { Pool } from 'pg';
import { eachTaskOnItsOwn, type TaskFailure } from './each-task';
import { taskLink } from './github-sync';

/** GitHub refuses a comment longer than this. */
const GITHUB_COMMENT_LIMIT = 65_536;

/** Between two earlier rounds folded into the comment's "Earlier rounds". */
const ROUND_SEPARATOR = '\n\n---\n\n';

interface ChooserResult {
  readonly checklist?: readonly string[];
  readonly beforeAfter?: readonly { key: string; locale: string; before: string; after: string }[];
}

const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');

const beforeAfterTable = (rows: NonNullable<ChooserResult['beforeAfter']>): string[] =>
  rows.length
    ? [
        '| Key | Locale | Before | After |',
        '| --- | --- | --- | --- |',
        ...rows.map(
          (row) =>
            `| \`${cell(row.key)}\` | ${cell(row.locale)} | ${cell(row.before)} | ${cell(row.after)} |`
        )
      ]
    : [];

/** Where the verification of one head stands, as the comment says it under the items. */
export type Verdict =
  | { readonly kind: 'waiting'; readonly approvedBy: readonly string[] }
  | { readonly kind: 'verified'; readonly by: readonly string[]; readonly at: Date }
  | { readonly kind: 'auto' }
  | { readonly kind: 'sent_back'; readonly by: string; readonly at: Date; readonly note: string }
  | { readonly kind: 'reopened' };

const day = (at: Date) => at.toISOString().slice(0, 10);

const names = (list: readonly string[]) =>
  list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};

const VERDICT_TEXT: { [K in Verdict['kind']]: (verdict: Extract<Verdict, { kind: K }>) => string } =
  {
    waiting: (verdict) =>
      `Waiting for verification.${verdict.approvedBy.length ? ` Approved so far by ${names(verdict.approvedBy)}.` : ''}`,
    verified: (verdict) => `**Verified** by ${names(verdict.by)} on ${day(verdict.at)}.`,
    auto: () =>
      "**Auto-verified**: the lane let this result skip a person's check, so nobody checked it.",
    sent_back: (verdict) =>
      `**Sent back** by ${verdict.by} on ${day(verdict.at)}: ${oneLine(verdict.note, 300)}`,
    reopened: () => 'The work went back to the builder before its verification finished.'
  };

const verdictText = (verdict: Verdict): string =>
  (VERDICT_TEXT[verdict.kind] as (verdict: Verdict) => string)(verdict);

/** What one round of the comment shows: one head's items, their latest checks and the verdict. */
export interface RoundInput {
  readonly items: readonly string[];
  readonly checks: readonly RecordedCheck[];
  readonly headSha: string;
  readonly verdict: Verdict;
}

const checkLine = (check: RecordedCheck | null) => {
  if (!check) return '  - not checked';
  const who = `${check.name} ${CHECK_CHANNEL_LABELS[check.channel]}`;
  const evidence = check.evidence ? `. ${check.evidence}` : '';
  return `  - ${CHECK_OUTCOME_LABELS[check.outcome]}: ${who}, ${day(check.at)}${evidence}`;
};

/**
 * One head's round: a box is ticked only when its latest check found it ok, and every item says
 * who checked it, how, and when, or that nobody did.
 */
export const checklistRound = (input: RoundInput): string => {
  const latest = latestChecks(input.checks, input.items.length);
  const counts = checkCounts(latest);
  const tally = [
    `${counts.ok} ${CHECK_OUTCOME_LABELS.ok}`,
    ...(counts.problem ? [`${counts.problem} ${CHECK_OUTCOME_LABELS.problem}`] : []),
    ...(counts.partial ? [`${counts.partial} ${CHECK_OUTCOME_LABELS.partial}`] : []),
    ...(counts.unchecked ? [`${counts.unchecked} not checked`] : [])
  ].join(', ');
  return [
    `Commit \`${input.headSha.slice(0, 7)}\`: ${tally}.`,
    '',
    ...input.items.flatMap((item, index) => [
      `- [${latest[index]?.outcome === 'ok' ? 'x' : ' '}] **${index + 1}.** ${item}`,
      checkLine(latest[index] ?? null)
    ]),
    '',
    verdictText(input.verdict)
  ].join('\n');
};

/** The whole comment: the current round, its before/after table, and the earlier rounds folded. */
export const checklistComment = (input: {
  readonly link: string;
  readonly round: string;
  readonly beforeAfter: NonNullable<ChooserResult['beforeAfter']>;
  readonly earlier: string;
}): string => {
  const head = [
    `### Verification checklist for ${input.link}`,
    '',
    `Checks are recorded in ${input.link}, on the board or through Claude; this comment follows them.`,
    '',
    input.round
  ].join('\n');
  const table = beforeAfterTable(input.beforeAfter);
  const withTable = table.length ? [head, '', ...table].join('\n') : head;
  // The largest checklist, checked at length, leaves no room for the largest table: the task
  // page shows it in full.
  const main =
    withTable.length < GITHUB_COMMENT_LIMIT
      ? withTable
      : `${head}\n\nThe before and after table is on ${input.link}.`;
  const fold = (earlier: string) =>
    earlier
      ? `${main}\n\n<details><summary>Earlier rounds</summary>\n\n${earlier}\n\n</details>`
      : main;
  const rounds = input.earlier ? input.earlier.split(ROUND_SEPARATOR) : [];
  // The oldest rounds give way first; the task's timeline keeps every check.
  while (rounds.length && fold(rounds.join(ROUND_SEPARATOR)).length >= GITHUB_COMMENT_LIMIT)
    rounds.pop();
  return fold(rounds.join(ROUND_SEPARATOR));
};

/** The earlier rounds after the head moved: the round last written goes on top of them. */
export const foldedEarlier = (stored: ChecklistCommentRow | null, headSha: string): string => {
  if (!stored) return '';
  if (stored.headSha === headSha || !stored.round) return stored.earlier;
  return stored.earlier ? `${stored.round}${ROUND_SEPARATOR}${stored.earlier}` : stored.round;
};

/** Where the verification of a head stands, from people's decisions on it and the task's stage. */
export const verdictOf = (input: {
  readonly stage: Task['stage'];
  readonly decisions: readonly VerifyingDecision[];
  readonly autoVerified: boolean;
}): Verdict => {
  if (input.autoVerified) return { kind: 'auto' };
  const last = input.decisions.at(-1);
  if (last?.decision === 'changes')
    return { kind: 'sent_back', by: last.name, at: last.at, note: last.note ?? '' };
  const approvals = input.decisions.filter((decision) => decision.decision === 'approve');
  const by = [...new Set(approvals.map((decision) => decision.name))];
  if ((input.stage === 'merging' || input.stage === 'done') && last)
    return { kind: 'verified', by, at: last.at };
  if (input.stage === 'verifying') return { kind: 'waiting', approvedBy: by };
  return { kind: 'reopened' };
};

export type ChecklistGitHubPort = Pick<GitHubClient, 'commentOnIssue' | 'editComment'>;

/** The task's pull request and the checklist under verification, when there is one to write. */
const checklistTarget = async (pool: Pool, taskId: string) => {
  const context = await loadTaskContext(pool, taskId);
  const headSha = context ? checklistHead(context.task) : null;
  if (!context?.pullRequest || !context.installationId || !headSha) return null;
  const chosen = (await latestChooserResult(pool, taskId)) as ChooserResult | null;
  if (!chosen?.checklist?.length) return null;
  return {
    context,
    pullRequest: context.pullRequest,
    ref: { installationId: context.installationId, repo: context.repo } satisfies RepoRef,
    subject: `sha:${headSha}`,
    headSha,
    items: chosen.checklist,
    beforeAfter: chosen.beforeAfter ?? []
  };
};

/** What the comment should say now, from what is recorded, and the comment as last written. */
const checklistWanted = async (
  pool: Pool,
  taskId: string,
  publicUrl: string,
  target: NonNullable<Awaited<ReturnType<typeof checklistTarget>>>
) => {
  const { context, subject, headSha } = target;
  const [checks, decisions, autoVerified, stored] = await Promise.all([
    listChecks(pool, taskId, headSha),
    listVerifyingDecisions(pool, taskId, subject),
    hasTaskEvent(pool, taskId, 'auto_verified', { subject }),
    loadChecklistComment(pool, taskId, target.pullRequest)
  ]);
  const round = checklistRound({
    items: target.items,
    checks,
    headSha,
    verdict: verdictOf({ stage: context.task.stage, decisions, autoVerified })
  });
  const earlier = foldedEarlier(stored, headSha);
  const body = checklistComment({
    link: taskLink(publicUrl, context.projectId, context.number),
    round,
    beforeAfter: target.beforeAfter,
    earlier
  });
  return { stored, round, earlier, body };
};

/**
 * Brings the checklist comment on a task's pull request in line with what is recorded: the chooser's
 * items for the head under verification, each one's latest check and where the verification
 * stands. Writes only when the text would change, so a second run with nothing new calls GitHub not
 * at all; the first post is claimed, so two writers never post two comments.
 */
export const syncChecklistComment = async (
  pool: Pool,
  github: ChecklistGitHubPort,
  input: { readonly taskId: string; readonly publicUrl: string }
): Promise<'unchanged' | 'posted' | 'edited' | 'none'> => {
  const target = await checklistTarget(pool, input.taskId);
  if (!target) return 'none';
  const { taskId } = input;
  const { pullRequest, ref, headSha } = target;
  const { stored, round, earlier, body } = await checklistWanted(
    pool,
    taskId,
    input.publicUrl,
    target
  );
  const record = (commentId: number) =>
    saveChecklistComment(pool, { taskId, pullRequest, commentId, headSha, round, earlier, body });
  if (stored?.commentId) {
    if (stored.body === body) return 'unchanged';
    await github.editComment({ ...ref, commentId: stored.commentId, body });
    await record(stored.commentId);
    return 'edited';
  }
  if (!(await claimChecklistComment(pool, taskId, pullRequest))) return 'none';
  const posted = await github.commentOnIssue({ ...ref, issueNumber: pullRequest, body });
  await record(posted.id);
  await appendTaskEvent(pool, {
    taskId,
    actor: ENGINE,
    type: 'checklist_posted',
    payload: { pullRequest }
  });
  return 'posted';
};

/** The checklist comment of each task, each on its own, for a scheduler pass. */
export const syncChecklistComments = (
  pool: Pool,
  github: ChecklistGitHubPort,
  taskIds: readonly string[],
  publicUrl: string
): Promise<TaskFailure[]> =>
  eachTaskOnItsOwn(taskIds, (taskId) => syncChecklistComment(pool, github, { taskId, publicUrl }));

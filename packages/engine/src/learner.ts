import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  computeLane,
  editsProject,
  isAgentDocsPath,
  isStandardsPage,
  requiredDocs,
  type AgentOutput,
  type ProjectConfig
} from '@officina/core';
import {
  failIdleLearningRewrite,
  failLearningRewrite,
  insertLearnings,
  learnerHasLooked,
  learningAwaitingRewrite,
  listProjectMemberProfiles,
  listRecentLearningTitles,
  listTaskComments,
  listTaskEvents,
  listTaskRuns,
  loadTaskContext,
  rewriteLearningEdit,
  startLearningRewriteRun,
  type LearningRow,
  type NewRun,
  type RunRow,
  type StoredTaskContext,
  type TaskEventRow
} from '@officina/db';
import { RUNNER_ROLES, type RunnerRole } from '@officina/runner';
import { DATA_NOTICE, closingSections, fence } from './brief';
import { PROJECT_SKIP_REASONS, claimStep, type SkipReason } from './claim';
import { learnerRun } from './learner-run';
import type { EngineDependencies, StepResult } from './step';

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)} … (${text.length - max} more characters)` : text;

const minutes = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 60_000);

const duration = (total: number) =>
  total < 60
    ? `${total} min`
    : total < 1440
      ? `${(total / 60).toFixed(1)} h`
      : `${(total / 1440).toFixed(1)} days`;

const describeEvent = (event: TaskEventRow): string | null => {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'stage_changed':
      return `stage ${p.from} -> ${p.to}`;
    case 'lane_changed':
      return `lane ${p.from ?? 'none'} -> ${p.to}`;
    case 'spec_versioned':
      return `spec version ${p.version}`;
    case 'approval_planned': {
      const plan = p.plan as { depth: string; rationale: string };
      const added = (p.added as unknown[]).map((item) => JSON.stringify(item)).join(', ');
      return `approval plan for ${p.gate}: depth ${plan.depth}${added ? `, added ${added}` : ''}. ${plan.rationale}`;
    }
    case 'approval_recorded':
      return `approved ${p.gate}${p.satisfied ? ' (gate passed)' : ' (more approvals needed)'}`;
    case 'changes_requested':
      return `changes requested at ${p.stage}: ${clip(String(p.note), 1500)}`;
    case 'pushed':
      return `${p.outside ? 'pushed from outside Officina' : 'pushed'} ${(p.changedPaths as string[]).length} files, ${p.diffLines} lines`;
    case 'build_unchanged':
      return `kept the head, nothing to change: ${clip(String(p.note), 1500)}`;
    case 'review_recorded':
      return `review ${p.verdict} by ${p.reviewer}: ${clip(String(p.notes), 1500)}`;
    case 'guardrail_tripped':
      return `guardrail ${p.guardrail}: ${p.details}`;
    case 'ci_failed':
      return `CI failed: ${clip(String(p.details), 800)}`;
    case 'blocked':
      return `question: ${clip(String((p.blocked as { question: string }).question), 1000)}`;
    case 'unblocked':
      return `answered: ${clip(String(p.answer), 1000)}`;
    case 'closed':
      return `closed as ${p.stage}: ${p.reason}`;
    case 'assigned':
    case 'user_visible_changed':
      return null;
    default:
      return event.type.replaceAll('_', ' ');
  }
};

const runLine = (run: RunRow) =>
  `- ${run.role} at ${run.stage}: ${run.status}` +
  (run.startedAt && run.finishedAt ? `, ${duration(minutes(run.startedAt, run.finishedAt))}` : '') +
  (run.costCents !== null ? `, $${(run.costCents / 100).toFixed(2)}` : '');

/**
 * Everything the learner needs about one finished task, as data: the request, the spec, every
 * decision with its actor and time, the agent runs, and what was already learned elsewhere.
 */
export const learnerBrief = async (
  deps: Pick<EngineDependencies, 'pool'>,
  taskId: string,
  config: ProjectConfig
): Promise<string | null> => {
  const { pool } = deps;
  const context = await loadTaskContext(pool, taskId);
  if (!context) return null;
  const [events, runs, comments, members, earlier] = await Promise.all([
    listTaskEvents(pool, taskId),
    listTaskRuns(pool, taskId),
    listTaskComments(pool, taskId),
    listProjectMemberProfiles(pool, context.projectId),
    listRecentLearningTitles(pool, context.projectId)
  ]);
  const names = new Map(members.map((member) => [member.id, member.name]));
  const who = (actor: TaskEventRow['actor']) =>
    actor.kind === 'member'
      ? (names.get(actor.memberId) ?? 'a former member')
      : actor.kind === 'agent'
        ? `${actor.role} agent`
        : 'engine';
  const first = events[0]?.createdAt;
  const last = events.at(-1)?.createdAt;
  const cost = runs.reduce((sum, run) => sum + (run.costCents ?? 0), 0);
  const fixRounds = events.filter(
    (event) =>
      event.type === 'changes_requested' ||
      (event.type === 'review_recorded' &&
        (event.payload as { verdict?: string }).verdict === 'changes')
  ).length;

  const timeline = events.flatMap((event) => {
    const text = describeEvent(event);
    return text
      ? [`- ${event.createdAt.toISOString().slice(0, 16)} ${who(event.actor)}: ${text}`]
      : [];
  });

  return [
    `# Officina task ${context.number}, role: learner`,
    `Repository: \`${context.repo}\`, default branch \`${context.defaultBranch}\`. Read \`${config.docs.entry}\` first.`,
    DATA_NOTICE,
    `## Title\n\n${fence(context.title)}`,
    `## Totals\n\n- Lead time: ${first && last ? duration(minutes(first, last)) : 'unknown'}\n- Agent cost: $${(cost / 100).toFixed(2)} across ${runs.length} runs\n- Rounds of changes: ${fixRounds}`,
    `## Final spec\n\n${fence(context.latestSpec ?? '(none)')}`,
    `## Timeline\n\n${fence(timeline.join('\n') || '(empty)')}`,
    `## Agent runs\n\n${runs.map(runLine).join('\n') || '- none'}`,
    `## Thread\n\n${comments.length ? comments.map((comment) => fence(`${who(comment.author)}: ${clip(comment.body, 2000)}`)).join('\n\n') : 'No comments.'}`,
    `## Already proposed or decided (do not repeat these)\n\n${earlier.length ? earlier.map((item) => `- [${item.status}] ${item.title} (${item.file})`).join('\n') : '- nothing yet'}`,
    [
      '## Where an edit may go',
      `- \`docs\`: the project's agent docs, read from \`${context.defaultBranch}\`: \`${config.docs.entry}\` and the pages under \`${config.docs.standards.dir}/\`, a new page there included. The first choice for a lesson about where code goes, the patterns to use, the shared code to reuse, testing, or pull request rules. Its pages:`,
      requiredDocs(config)
        .map((path) => `  - \`${path}\``)
        .join('\n'),
      `- \`project\`: any other Markdown file in this repository, read from \`${context.defaultBranch}\`. Never a protected path:`,
      config.lanes.red.paths.map((path) => `  - \`${path}\``).join('\n') || '  - none',
      `- \`agent\`: one of Officina's role prompts: ${RUNNER_ROLES.map((role) => `\`agents/${role}.md\``).join(', ')}.`
    ].join('\n'),
    ...closingSections(config.guards.confidential)
  ].join('\n\n');
};

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/**
 * Checks each proposed edit can be applied exactly as written, so what people accept is what
 * lands: the file exists, it is Markdown outside protected paths, and any text to replace is found
 * exactly once.
 */
export const learningProblems =
  (input: {
    deps: EngineDependencies;
    repoRef: { installationId: number; repo: string };
    branch: string;
    config: ProjectConfig;
  }) =>
  async (output: AgentOutput<RunnerRole>): Promise<string[]> => {
    const problems: string[] = [];
    const { learnings } = output as AgentOutput<'learner'>;
    for (const [index, learning] of learnings.entries()) {
      const at = `learnings.${index}`;
      const { file, find } = learning.edit;
      let content: string | null = null;
      if (editsProject(learning.target)) {
        if (!file.endsWith('.md') || file.startsWith('/') || file.includes('..')) {
          problems.push(
            `${at}: project edits go to a Markdown file in the repository, not ${file}`
          );
          continue;
        }
        // One target per file, so the board and the pull request say what kind of doc changes. A
        // tool layer such as CLAUDE.md is a pointer to the entry document and takes no rule at all.
        if (learning.target === 'docs' && !isStandardsPage(input.config, file)) {
          problems.push(
            `${at}: docs edits go to ${input.config.docs.entry} or a page under ${input.config.docs.standards.dir}/, not ${file}${isAgentDocsPath(input.config, file) ? ', a pointer to the entry document' : '; use target project'}`
          );
          continue;
        }
        if (learning.target === 'project' && isAgentDocsPath(input.config, file)) {
          problems.push(
            `${at}: ${file} is part of the agent docs; ${isStandardsPage(input.config, file) ? 'use target docs' : 'it is a pointer to the entry document and takes no rule'}`
          );
          continue;
        }
        if (computeLane([file], input.config.laneMatcher) === 'red') {
          problems.push(`${at}: ${file} is a protected path`);
          continue;
        }
        content =
          (await input.deps.github.readFile({ ...input.repoRef, path: file, branch: input.branch }))
            ?.text ?? null;
        if (content === null && find) {
          problems.push(`${at}: ${file} does not exist, so there is nothing to replace`);
          continue;
        }
      } else {
        const role = /^agents\/([a-z_]+)\.md$/.exec(file)?.[1];
        if (!role || !(RUNNER_ROLES as readonly string[]).includes(role)) {
          problems.push(`${at}: agent edits go to agents/<role>.md for a known role, not ${file}`);
          continue;
        }
        if (input.deps.promptsDir)
          content = await readFile(join(input.deps.promptsDir, `${role}.md`), 'utf8').catch(
            () => null
          );
      }
      if (find && content !== null && occurrences(content, find) !== 1) {
        problems.push(
          `${at}: the text to replace must appear exactly once in ${file}, it appears ${occurrences(content, find)} times`
        );
      }
    }
    return problems;
  };

/**
 * Everything the learner needs to rewrite one learning whose edit the default branch has moved
 * past: the learning as people saw it and the edit that no longer applies.
 */
export const rewriteBrief = (
  context: StoredTaskContext,
  config: ProjectConfig,
  learning: LearningRow
): string =>
  [
    `# Officina task ${context.number}, role: learner, rewriting one edit`,
    `Repository: \`${context.repo}\`, default branch \`${context.defaultBranch}\`. Read \`${config.docs.entry}\` first.`,
    DATA_NOTICE,
    `A learning proposed after this task is still waiting for people, but its edit no longer applies: \`${learning.file}\` changed on \`${context.defaultBranch}\` since. Read the file as it is now and return this one learning, with the same title, lesson, evidence and target, and an edit to the same file that makes the same addition to the file as it is now, in its current style. Return no learnings when the file already says it.`,
    `## Title\n\n${fence(learning.title)}`,
    `## Lesson\n\n${fence(learning.lesson)}`,
    `## Evidence\n\n${fence(learning.evidence)}`,
    `## Target\n\n\`${learning.target}\``,
    `## The edit that no longer applies\n\nFile: \`${learning.file}\`\n\nText to replace:\n\n${fence(learning.find ?? '(none, appended at the end)')}\n\nReplacement:\n\n${fence(learning.text)}`,
    ...closingSections(config.guards.confidential)
  ].join('\n\n');

/** A rewrite returns the one learning it was given, or none; the edit is checked like any other. */
const rewriteProblems =
  (learning: LearningRow, checkEdits: ReturnType<typeof learningProblems>) =>
  async (output: AgentOutput<RunnerRole>): Promise<string[]> => {
    const { learnings } = output as AgentOutput<'learner'>;
    const problems: string[] = [];
    if (learnings.length > 1)
      problems.push('learnings: return this one learning rewritten, or none');
    if (learnings.some((item) => item.target !== learning.target))
      problems.push(`learnings.0: keep the target ${learning.target}`);
    if (learnings.some((item) => item.edit.file !== learning.file))
      problems.push(`learnings.0: keep the file ${learning.file}`);
    return [...problems, ...(await checkEdits(output))];
  };

/**
 * A rewrite gets one more run when the engine loses the first (a restart fails it); after that it
 * fails, so a lost run never turns into a session on every pass.
 */
const REWRITE_ATTEMPTS = 2;

const blockedByProject = (reason: SkipReason) =>
  (PROJECT_SKIP_REASONS as readonly SkipReason[]).includes(reason);

/**
 * Looks back at one done task and proposes what the project or the agents should learn from it,
 * or rewrites the edit of one of its learnings that no longer applies. The task itself never
 * changes; the learnings wait for people to accept or reject them.
 */
export const runLearnerStep = async (
  deps: EngineDependencies,
  taskId: string
): Promise<StepResult> => {
  const { pool } = deps;
  // What the run is for is settled once, before it is claimed: a learning settled meanwhile is found
  // so by the claim, and never turns the run into a second look back.
  const rewrite: LearningRow | null = await learningAwaitingRewrite(pool, taskId);
  const claimed = await claimStep(pool, {
    taskId,
    role: 'learner',
    // One look back per task: a finished or failed attempt is never repeated. A rewrite people
    // asked for is due whenever it waits.
    isDue: async (context) =>
      rewrite !== null ||
      (context.task.stage === 'done' && !(await learnerHasLooked(pool, taskId))),
    ...(rewrite && {
      start: (run: NewRun) => startLearningRewriteRun(pool, run, rewrite.id, REWRITE_ATTEMPTS)
    })
  });
  if (!claimed.ok) {
    // A rewrite the project cannot run would otherwise wait on every pass, and block its accept.
    if (rewrite && blockedByProject(claimed.reason))
      await failIdleLearningRewrite(pool, rewrite.id);
    return { status: 'skipped', reason: claimed.reason };
  }
  const step = claimed.step;
  const { context, config, runId, repoRef } = step;
  const checkEdits = learningProblems({ deps, repoRef, branch: context.defaultBranch, config });

  if (rewrite) {
    return learnerRun(deps, step, {
      brief: () => rewriteBrief(context, config, rewrite),
      validate: rewriteProblems(rewrite, checkEdits),
      keep: async ({ learnings: [rewritten] }) =>
        rewritten
          ? rewriteLearningEdit(pool, rewrite.id, rewritten.edit)
          : failLearningRewrite(pool, rewrite.id),
      lose: () => failLearningRewrite(pool, rewrite.id)
    });
  }
  return learnerRun(deps, step, {
    brief: async () => (await learnerBrief(deps, taskId, config)) ?? '',
    validate: checkEdits,
    keep: (output) =>
      insertLearnings(pool, {
        projectId: context.projectId,
        taskId,
        runId,
        learnings: output.learnings
      }),
    lose: async () => {}
  });
};

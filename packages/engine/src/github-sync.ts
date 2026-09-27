import { branchForTask, parseProjectConfig, type Actor } from '@officina/core';
import { appendTaskEvent, hasTaskEvent, loadTaskContext } from '@officina/db';
import type { GitHubClient, RepoRef } from '@officina/github';
import type { Pool } from 'pg';

export type SyncGitHubPort = Pick<
  GitHubClient,
  'readFile' | 'updateFile' | 'pushFacts' | 'commentOnIssue'
>;

const ENGINE: Actor = { kind: 'engine' };

/** The spec file a task's branch adds, found by the project's spec directory. */
export const specPathIn = (
  changedPaths: readonly string[],
  specDir: string | null
): string | null => {
  if (!specDir) return null;
  const pattern = new RegExp(
    `^${specDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/$/, '')}/[^/]+\\.md$`
  );
  return changedPaths.find((path) => pattern.test(path)) ?? null;
};

/**
 * Sets the spec's `Status:` line on the task branch, once per status. The builder cannot do it: it
 * does not know the pull request number when it pushes.
 */
export const syncSpecStatus = async (
  pool: Pool,
  github: SyncGitHubPort,
  input: {
    readonly taskId: string;
    readonly ref: RepoRef;
    readonly branch: string;
    readonly base: string;
    readonly specDir: string | null;
    readonly status: string;
  }
): Promise<'updated' | 'unchanged' | 'no_spec'> => {
  if (await hasTaskEvent(pool, input.taskId, 'spec_status_set', { status: input.status })) {
    return 'unchanged';
  }
  const facts = await github.pushFacts({ ...input.ref, base: input.base, branch: input.branch });
  const path = specPathIn(facts.changedPaths, input.specDir);
  if (!path) return 'no_spec';
  const file = await github.readFile({ ...input.ref, path, branch: input.branch });
  if (!file) return 'no_spec';
  const text = file.text.replace(/^Status: .*$/m, `Status: ${input.status}`);
  if (text !== file.text) {
    await github.updateFile({
      ...input.ref,
      path,
      branch: input.branch,
      text,
      sha: file.sha,
      message: `docs(spec): mark ${path.split('/').pop()!.replace(/\.md$/, '')} ${input.status}`
    });
  }
  await appendTaskEvent(pool, {
    taskId: input.taskId,
    actor: ENGINE,
    type: 'spec_status_set',
    payload: { status: input.status, path }
  });
  return text === file.text ? 'unchanged' : 'updated';
};

interface ChooserResult {
  readonly checklist?: readonly string[];
  readonly beforeAfter?: readonly { key: string; locale: string; before: string; after: string }[];
}

const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');

/** The verification checklist as markdown, for the pull request and for people reading it there. */
export const checklistMarkdown = (result: unknown, taskLink: string): string | null => {
  const chosen = result as ChooserResult | null;
  if (!chosen?.checklist?.length) return null;
  const lines = [
    `### Verification checklist for ${taskLink}`,
    '',
    ...chosen.checklist.map((item) => `- [ ] ${item}`)
  ];
  if (chosen.beforeAfter?.length) {
    lines.push('', '| Key | Locale | Before | After |', '| --- | --- | --- | --- |');
    for (const row of chosen.beforeAfter) {
      lines.push(
        `| \`${cell(row.key)}\` | ${cell(row.locale)} | ${cell(row.before)} | ${cell(row.after)} |`
      );
    }
  }
  return lines.join('\n');
};

/** Posts the chooser's checklist on the pull request, once. */
export const postChecklist = async (
  pool: Pool,
  github: SyncGitHubPort,
  input: { taskId: string; ref: RepoRef; pullRequest: number; taskLink: string; result: unknown }
) => {
  if (
    await hasTaskEvent(pool, input.taskId, 'checklist_posted', { pullRequest: input.pullRequest })
  )
    return;
  const body = checklistMarkdown(input.result, input.taskLink);
  if (!body) return;
  await github.commentOnIssue({ ...input.ref, issueNumber: input.pullRequest, body });
  await appendTaskEvent(pool, {
    taskId: input.taskId,
    actor: ENGINE,
    type: 'checklist_posted',
    payload: { pullRequest: input.pullRequest }
  });
};

/**
 * Marks the spec Implemented once people have verified the result: the final commit before merge,
 * as the spec workflow asks.
 */
export const finishVerifiedSpecs = async (
  pool: Pool,
  github: SyncGitHubPort,
  taskIds: readonly string[]
) => {
  for (const taskId of taskIds) {
    const context = await loadTaskContext(pool, taskId);
    if (
      !context ||
      context.task.stage !== 'merging' ||
      !context.pullRequest ||
      !context.installationId
    )
      continue;
    const config = parseProjectConfig(context.rawConfig);
    if (!config.ok) continue;
    await syncSpecStatus(pool, github, {
      taskId,
      ref: { installationId: context.installationId, repo: context.repo },
      branch: branchForTask(context.number),
      base: context.defaultBranch,
      specDir: config.config.docs.specDir,
      status: `Implemented (#${context.pullRequest})`
    });
  }
};

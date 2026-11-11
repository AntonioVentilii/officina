import { requiredDocs, type Actor, type ProjectConfig } from '@officina/core';
import {
  applyCommand,
  createOnboardingTask,
  insertOnboardingTask,
  openOnboardingTask,
  type NewOnboardingTask
} from '@officina/db';
import type { Pool, PoolClient } from 'pg';
import { list } from './brief';

export const ONBOARDING_TITLE = 'Write the agent docs for this repository';

/**
 * The spec people approve before the onboarder writes a project's agent docs. The onboarder's own
 * prompt says how to write each page; this says what this repository lacks and what done means.
 */
export const onboardingSpec = (
  repo: string,
  config: Pick<ProjectConfig, 'docs'>,
  missing: readonly string[]
): string =>
  [
    `# Agent docs for \`${repo}\``,
    '## Goal',
    'Agents and people working in this repository reuse what already exists and put new code where it belongs, because the repository documents its own structure, patterns and shared code next to the universal code standard.',
    '## Context',
    `Officina builds nothing else in this project until this change is merged. Missing on the default branch when the project was registered:\n\n${list(missing)}`,
    '## Change',
    [
      `- \`${config.docs.entry}\`: the short entry point, linking the code standard and adding only what is specific to this repository.`,
      '- `CLAUDE.md` and any other tool layer: a thin pointer to the entry document; every rule they hold moves once to the right page.',
      `- Every page of \`${config.docs.standards.dir}/\` below, read off the code and the git history, with real paths:`,
      list(config.docs.standards.pages)
    ].join('\n'),
    '## Out of scope',
    'Any file outside the agent docs. The smells found while reading the code (duplicates, god files, misplaced code) are listed as follow-ups in the pull request, not fixed here.',
    '## Verify',
    [
      `- Every required file exists: ${requiredDocs(config)
        .map((path) => `\`${path}\``)
        .join(', ')}.`,
      '- Every path and `path:line` a page names exists.',
      '- The code standard is linked, never copied.',
      "- The project's verify commands pass."
    ].join('\n')
  ].join('\n\n');

const ENGINE: Actor = { kind: 'engine' };

export interface OnboardingInput {
  readonly projectId: string;
  readonly requesterId: string;
  readonly repo: string;
  readonly config: ProjectConfig;
  readonly missing: readonly string[];
}

const onboardingTask = (input: OnboardingInput): NewOnboardingTask => ({
  projectId: input.projectId,
  requesterId: input.requesterId,
  title: ONBOARDING_TITLE,
  spec: onboardingSpec(input.repo, input.config, input.missing),
  paths: requiredDocs(input.config),
  config: input.config
});

/**
 * Opens the onboarding task inside the caller's transaction, unless one is open. Registration uses
 * it so a project is never schedulable without the gate its missing pages call for.
 */
export const openOnboardingIn = async (
  client: PoolClient,
  input: OnboardingInput
): Promise<number> => (await insertOnboardingTask(client, onboardingTask(input))).number;

/**
 * Opens the onboarding task when a project lacks required agent docs, unless one is already open.
 * Returns the task's number, or `null` when nothing is missing. When nothing is missing but an
 * onboarding task is still open (people wrote the pages themselves and merged them), that task is
 * cancelled, so the gate it holds lifts without anyone having to find it on the board.
 */
export const ensureOnboarding = async (
  pool: Pool,
  input: OnboardingInput
): Promise<number | null> => {
  if (input.missing.length === 0) {
    const open = await openOnboardingTask(pool, input.projectId);
    if (open) {
      await applyCommand(pool, {
        taskId: open.id,
        command: {
          type: 'cancel',
          reason: 'every required agent docs page is on the default branch already'
        },
        actor: ENGINE
      });
    }
    return null;
  }
  const task = await createOnboardingTask(pool, onboardingTask(input));
  return task.number;
};

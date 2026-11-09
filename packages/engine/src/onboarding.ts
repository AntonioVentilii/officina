import { requiredDocs, type ProjectConfig } from '@officina/core';
import { createOnboardingTask } from '@officina/db';
import type { Pool } from 'pg';

export const ONBOARDING_TITLE = 'Write the agent docs for this repository';

const list = (items: readonly string[]) => items.map((item) => `- \`${item}\``).join('\n');

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

/**
 * Opens the onboarding task when a project lacks required agent docs, unless one is already open.
 * Returns the task's number, or `null` when nothing is missing.
 */
export const ensureOnboarding = async (
  pool: Pool,
  input: {
    readonly projectId: string;
    readonly requesterId: string;
    readonly repo: string;
    readonly config: ProjectConfig;
    readonly missing: readonly string[];
  }
): Promise<number | null> => {
  if (input.missing.length === 0) return null;
  const task = await createOnboardingTask(pool, {
    projectId: input.projectId,
    requesterId: input.requesterId,
    title: ONBOARDING_TITLE,
    spec: onboardingSpec(input.repo, input.config, input.missing),
    paths: requiredDocs(input.config),
    config: input.config
  });
  return task.number;
};

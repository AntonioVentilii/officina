import { parseProjectConfig, type AgentOutput } from '@officina/core';
import { loadTaskContext } from '@officina/db';
import type { GitHubClient, RepoRef } from '@officina/github';
import type { RunnerRole } from '@officina/runner';
import type { Pool } from 'pg';

/** The project's pull request template (`docs.pr_template`), as read from its default branch. */
export interface PrTemplate {
  readonly path: string;
  /** Its Markdown headings, which a body written in it keeps. */
  readonly headings: readonly string[];
}

const COMMENT = /<!--[\s\S]*?-->/g;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** The line under a setext heading: `===` or `---`. */
const UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
/** A line of plain paragraph text, the only kind a setext underline turns into a heading. */
const PARAGRAPH = /^ {0,3}(?![-*+>|#=]|\d+[.)])\S/;

/** Whether a fence marker closes the open fence: the same character, at least as long. */
const closes = (open: string, marker: string) =>
  marker[0] === open[0] && marker.length >= open.length;

/** The lines outside comments, with fences and fenced code blanked, so nothing in them counts. */
const proseLines = (markdown: string): string[] => {
  let fence: string | null = null;
  return markdown
    .replace(COMMENT, '')
    .split('\n')
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence === null && marker) fence = marker;
      else if (fence !== null && marker && closes(fence, marker)) fence = null;
      else if (fence === null) return line;
      return '';
    });
};

/** The text of each heading, ATX (`# Tests`) or setext (`Tests` over `===`), in order. */
export const headingsOf = (markdown: string): string[] => {
  const headings: string[] = [];
  let previous: string | null = null;
  for (const line of proseLines(markdown)) {
    const heading: string | undefined =
      HEADING.exec(line)?.[1] ?? (previous !== null && UNDERLINE.test(line) ? previous : undefined);
    if (heading) headings.push(heading.trim());
    previous = heading === undefined && PARAGRAPH.test(line) ? line : null;
  }
  return headings;
};

/**
 * The template the project names, or `null` when it names none or it cannot be read: a missing or
 * unreadable template leaves the pull request body as Officina writes it.
 */
export const readPrTemplate = async (
  github: Pick<GitHubClient, 'readFile'>,
  ref: RepoRef,
  input: { readonly path: string | null; readonly branch: string }
): Promise<PrTemplate | null> => {
  const { path } = input;
  if (!path) return null;
  const file = await github.readFile({ ...ref, path, branch: input.branch }).catch(() => null);
  return file ? { path, headings: headingsOf(file.text) } : null;
};

/**
 * The template a task's build is held to, read as `handInBuild` reads it, for whoever tells a
 * developer what to hand in: `null` exactly when a hand-in takes no body.
 */
export const taskPrTemplate = async (
  pool: Pool,
  github: Pick<GitHubClient, 'readFile'>,
  taskId: string
): Promise<PrTemplate | null> => {
  const context = await loadTaskContext(pool, taskId);
  if (!context || context.installationId === null) return null;
  const config = parseProjectConfig(context.rawConfig);
  if (!config.ok) return null;
  return readPrTemplate(
    github,
    { installationId: context.installationId, repo: context.repo },
    { path: config.config.docs.prTemplate, branch: context.defaultBranch }
  );
};

const key = (heading: string) => heading.toLowerCase();

/**
 * A pushed build's body against the project's template: there must be one, and it keeps every
 * heading of the template. Without a template there must be none, so a body stored with a result
 * always stands for one and Officina's own body is kept otherwise. The same check for an agent's
 * build and a developer's hand-in.
 */
export const bodyProblems =
  (template: PrTemplate | null) =>
  (output: AgentOutput<RunnerRole>): string[] => {
    const built = output as AgentOutput<'builder' | 'onboarder'>;
    if (built.outcome !== 'pushed') return [];
    if (!template)
      return built.prBody
        ? ['prBody is only for a project whose pull request template can be read: leave it out']
        : [];
    if (!built.prBody)
      return [`prBody is required: write it in the pull request template at ${template.path}`];
    const kept = new Set(headingsOf(built.prBody).map(key));
    return template.headings
      .filter((heading) => !kept.has(key(heading)))
      .map((heading) => `prBody misses the heading "${heading}" of ${template.path}`);
  };

import type { AgentOutput } from '@officina/core';
import type { GitHubClient, RepoRef } from '@officina/github';
import type { RunnerRole } from '@officina/runner';

/** The project's pull request template (`docs.pr_template`), as read from its default branch. */
export interface PrTemplate {
  readonly path: string;
  /** Its Markdown headings, which a body written in it keeps. */
  readonly headings: readonly string[];
}

const COMMENT = /<!--[\s\S]*?-->/g;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Whether a fence marker closes the open fence: the same character, at least as long. */
const closes = (open: string, marker: string) =>
  marker[0] === open[0] && marker.length >= open.length;

/** The text of each ATX heading outside comments and fenced code, in order. */
export const headingsOf = (markdown: string): string[] => {
  const headings: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.replace(COMMENT, '').split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker && closes(fence, marker)) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const heading = HEADING.exec(line)?.[1];
    if (heading) headings.push(heading.trim());
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

const key = (heading: string) => heading.toLowerCase();

/**
 * A pushed build's body against the project's template: there must be one, and it keeps every
 * heading of the template. The same check for an agent's build and a developer's hand-in.
 */
export const bodyProblems =
  (template: PrTemplate | null) =>
  (output: AgentOutput<RunnerRole>): string[] => {
    const built = output as AgentOutput<'builder' | 'onboarder'>;
    if (!template || built.outcome !== 'pushed') return [];
    if (!built.prBody)
      return [`prBody is required: write it in the pull request template at ${template.path}`];
    const kept = new Set(headingsOf(built.prBody).map(key));
    return template.headings
      .filter((heading) => !kept.has(key(heading)))
      .map((heading) => `prBody misses the heading "${heading}" of ${template.path}`);
  };

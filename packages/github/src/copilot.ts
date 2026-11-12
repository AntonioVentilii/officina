/** The accounts Copilot code review submits as; other bots' reviews are not read as Copilot's. */
export const COPILOT_REVIEWERS: ReadonlySet<string> = new Set([
  'copilot-pull-request-reviewer[bot]',
  'Copilot'
]);

/**
 * Copilot always submits a comment-state review and states its verdict as a heading in the body,
 * so the verdict is read from the text, not from the review's state.
 */
export const COPILOT_VERDICTS = {
  approval: 'Approval recommended',
  closer_look: 'Needs a closer look',
  changes: 'Changes recommended'
} as const;

export type CopilotVerdict = keyof typeof COPILOT_VERDICTS;

const HEADING = /^#{1,6}\s+\S+\s+(.+?)\s*$/gm;

/** The verdict of a Copilot review body, or `null` when it carries none (it reviewed nothing). */
export const copilotVerdict = (body: string): CopilotVerdict | null => {
  for (const [, title] of body.matchAll(HEADING)) {
    const verdict = (Object.keys(COPILOT_VERDICTS) as CopilotVerdict[]).find(
      (key) => COPILOT_VERDICTS[key] === title
    );
    if (verdict) return verdict;
  }
  return null;
};

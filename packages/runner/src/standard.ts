import { join } from 'node:path';

/**
 * The universal code standard. Officina's repository holds the only copy; every other repository
 * links it at `STANDARD_URL`, so neither the path nor the URL may move.
 */
export const STANDARD_PATH = join(import.meta.dir, '..', '..', '..', 'standards', 'code.md');
export const STANDARD_URL =
  'https://github.com/AntonioVentilii/officina/blob/main/standards/code.md';

export const loadStandard = (path: string = STANDARD_PATH): Promise<string> =>
  Bun.file(path).text();

/** Officina's role prompts in this checkout, one `<role>.md` each. */
export const PROMPTS_DIR = join(import.meta.dir, '..', '..', '..', 'agents');

/** A role's prompt, read from a folder of role prompts (`PROMPTS_DIR` in production). */
export const loadPrompt = (promptsDir: string, role: string): Promise<string> =>
  Bun.file(join(promptsDir, `${role}.md`)).text();

/**
 * A role's system prompt followed by the standard, so every role holds the code it specs, writes,
 * reviews or learns from to the same rules, and a change to the standard becomes a new agent version.
 */
export const withStandard = (prompt: string, standard: string): string =>
  [
    prompt.trimEnd(),
    '---',
    `Every project Officina serves follows the code standard below (its canonical copy is ${STANDARD_URL}). The project's own \`docs/ai/**\` pages add what is specific to it; where they and the standard disagree, the truth hierarchy at its end decides. Cite a rule by its number and name.`,
    standard.trim()
  ].join('\n\n');

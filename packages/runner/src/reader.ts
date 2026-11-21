/**
 * The reading worker: a cheaper agent a role hands its exploration to, so what it reads stays in
 * the worker's own context and only its short answer reaches the role's, which every later request
 * of the session reads again.
 */
export const READER_NAME = 'officina-reader';

/** Its prompt in the role prompts folder: `agents/reader.md`. */
export const READER_PROMPT = 'reader';

/** A role's prompt followed by when and how to hand reading to the reader. */
export const withReader = (prompt: string): string =>
  [
    prompt.trimEnd(),
    '---',
    `You can hand reading to ${READER_NAME}, a fast, low-cost agent that shares your workspace and can only read, glob and grep. Send it one self-contained question at a time, naming the paths, symbols or pages to look at: where a function is defined and who calls it, which tests cover a module, which shared helper already does a job, what a docs page says about a topic. It answers with file paths, line numbers and short quotes, and what it reads never enters your context. Several questions can go out at once; the answers come back in a later turn.`,
    `Use it when an answer means reading more than a few hundred lines or many files. Read small files, and the lines you change or cite, yourself. Never act on its answer alone: read every line you edit or quote before relying on it. Keep every judgment for yourself (what to change, whether a rule is broken, your result). It cannot write files, run commands or submit your result.`
  ].join('\n\n');

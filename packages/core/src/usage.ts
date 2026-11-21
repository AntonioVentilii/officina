/**
 * What a run's session used, as Managed Agents reports it: the list cost and the tokens. A run's
 * cost is its model requests times the context each one reads, so the tokens are what tell two
 * models, two efforts or two roles apart. The runner reads them, the store keeps them on the run
 * and the board adds them up per role.
 */

/** A session's tokens of each kind; cache writes of every cache lifetime are added together. */
export interface RunTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface RunUsage {
  readonly costCents: number | null;
  /** None when the session reported no usage, or could not be read. */
  readonly tokens: RunTokens | null;
}

/** The usage of a run whose session was never read. */
export const NO_USAGE: RunUsage = { costCents: null, tokens: null };

export const NO_TOKENS: RunTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Two counts added kind by kind; a run with no tokens adds nothing. */
export const addTokens = (total: RunTokens, more: RunTokens | null): RunTokens =>
  more
    ? {
        input: total.input + more.input,
        output: total.output + more.output,
        cacheRead: total.cacheRead + more.cacheRead,
        cacheWrite: total.cacheWrite + more.cacheWrite
      }
    : total;

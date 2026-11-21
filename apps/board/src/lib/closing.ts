import { dateTime } from '#lib/format.ts';

type Payload = Readonly<Record<string, unknown>>;

/** How the timeline says a task was closed, by the stage it was closed to. */
const CLOSED_AS: Readonly<Record<string, string>> = {
  declined: 'declined it',
  cancelled: 'cancelled it',
  done: 'closed it as done'
};

/**
 * The timeline's sentences for how a task closed: declined, cancelled or closed as done with a
 * reason, and a pull request merged on GitHub before people verified it, with who merged it and
 * when, if GitHub said.
 */
export const CLOSING_SENTENCES: Readonly<Record<string, (payload: Payload) => string>> = {
  closed: (payload) =>
    `${CLOSED_AS[String(payload.stage)] ?? 'closed it'}: ${String(payload.reason)}`,
  pull_request_merged_early: (payload) => {
    const by = payload.by ? ` by @${String(payload.by)}` : '';
    const at = typeof payload.at === 'string' ? ` at ${dateTime(payload.at)}` : '';
    return `found pull request #${String(payload.pullRequest)} merged on GitHub${by}${at}, before people verified it`;
  }
};

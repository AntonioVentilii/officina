/** One change GitHub recorded on a ref: who made it and where it left the ref. */
export interface RefActivity {
  /** The account that made it; a GitHub App shows as `<app-slug>[bot]`. */
  readonly actor: string | null;
  /** The sha the ref pointed at afterwards, all zeros once it was deleted. */
  readonly after: string;
}

/** The changes GitHub recorded on one ref since a moment, and whether that is all of them. */
export interface RefActivityLog {
  readonly activities: readonly RefActivity[];
  /** False when the page was full of recent changes, so some in the window may be missing. */
  readonly complete: boolean;
}

/** The repository activity endpoint lists at most this many changes per page. */
export const ACTIVITY_PAGE = 100;

const DAY_MS = 86_400_000;

/** The `time_period` values the activity endpoint takes, with the days each reaches back. */
const PERIODS = [
  ['day', 1],
  ['week', 7],
  ['month', 31],
  ['quarter', 92],
  ['year', 366]
] as const;

/** The shortest `time_period` that reaches back to `since`. */
export const activityPeriod = (since: Date, nowMs: number): string =>
  PERIODS.find(([, days]) => nowMs - since.getTime() < days * DAY_MS)?.[0] ?? 'year';

/** One entry of `GET /repos/{owner}/{repo}/activity`, as far as the ref guard reads it. */
export interface ActivityItem {
  readonly after: string;
  readonly timestamp: string;
  readonly actor: { readonly login: string } | null;
}

/** The entries of one page, newest first as GitHub lists them, made at or after `since`. */
export const activitySince = (items: readonly ActivityItem[], since: Date): RefActivityLog => {
  const recent = items.filter((item) => Date.parse(item.timestamp) >= since.getTime());
  return {
    activities: recent.map((item) => ({ actor: item.actor?.login ?? null, after: item.after })),
    complete: items.length < ACTIVITY_PAGE || recent.length < items.length
  };
};

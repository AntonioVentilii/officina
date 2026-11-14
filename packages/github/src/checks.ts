import { GitHubError } from './http';

/** Check suite conclusions that mean the checks failed. */
const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'action_required',
  'startup_failure'
]);

/** Commit status states that mean the status failed. */
const FAILED_STATUSES: ReadonlySet<string> = new Set(['failure', 'error']);

export interface CheckSuite {
  readonly conclusion?: string | null;
  readonly app?: { readonly name?: string };
}

export interface CommitStatus {
  readonly state?: string;
  readonly context?: string;
  readonly description?: string | null;
  readonly target_url?: string | null;
}

/** What a failed check suite says for the builder, or `null` when it did not fail. */
export const suiteFailure = (suite: CheckSuite): string | null =>
  suite.conclusion && FAILED_CONCLUSIONS.has(suite.conclusion)
    ? `${suite.app?.name ?? 'checks'}: ${suite.conclusion}`
    : null;

/**
 * What a failed commit status says for the builder, with where to look, or `null` when it did not
 * fail. Commit statuses are what CI outside GitHub Actions reports with, such as a deploy preview.
 */
export const statusFailure = (status: CommitStatus): string | null => {
  if (!status.state || !FAILED_STATUSES.has(status.state)) return null;
  return [
    `${status.context ?? 'status'}: ${status.state}`,
    status.description ? `(${status.description})` : null,
    status.target_url ?? null
  ]
    .filter(Boolean)
    .join(' ');
};

/**
 * What already failed on a commit, its check suites and latest commit statuses, as the webhooks
 * would have reported them: for a head Officina takes in after GitHub sent those webhooks. A
 * repository where the App may not read commit statuses (the permission is not granted yet) has
 * none to report, and its check suites still count.
 */
export const failuresOn = async (
  get: <T>(path: string) => Promise<T>,
  repo: string,
  sha: string
): Promise<string[]> => {
  const suites = await get<{ check_suites?: CheckSuite[] }>(
    `/repos/${repo}/commits/${sha}/check-suites?per_page=100`
  );
  const statuses = await get<{ statuses?: CommitStatus[] }>(
    `/repos/${repo}/commits/${sha}/status`
  ).catch((error: unknown) => {
    if (error instanceof GitHubError && (error.status === 403 || error.status === 404))
      return { statuses: [] };
    throw error;
  });
  return [
    ...(suites.check_suites ?? []).map(suiteFailure),
    ...(statuses.statuses ?? []).map(statusFailure)
  ].filter((failure): failure is string => failure !== null);
};

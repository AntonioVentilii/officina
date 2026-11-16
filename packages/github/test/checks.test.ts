import { describe, expect, test } from 'bun:test';
import { GitHubError, failuresOn } from '../src';

const BRANCH = 'officina/task-3';
const commit = { sha: 'abc', branch: BRANCH };

const answers =
  (statuses: unknown) =>
  async <T>(path: string): Promise<T> => {
    if (path.endsWith('/check-suites?per_page=100'))
      return {
        check_suites: [
          { conclusion: 'success', head_branch: BRANCH, app: { name: 'Vercel' } },
          { conclusion: 'failure', head_branch: BRANCH, app: { name: 'GitHub Actions' } },
          { conclusion: null, head_branch: BRANCH, app: { name: 'Pending' } },
          { conclusion: 'action_required', head_branch: BRANCH, app: { name: 'Approval' } },
          // The same commit pushed to another branch, or to a fork with a pull request open.
          { conclusion: 'failure', head_branch: 'main', app: { name: 'Elsewhere' } },
          { conclusion: 'failure', head_branch: null, app: { name: 'Fork' } },
          {
            conclusion: 'failure',
            head_branch: BRANCH,
            app: { name: 'Fork named alike' },
            pull_requests: [{ head: { repo: { id: 2 } }, base: { repo: { id: 1 } } }]
          }
        ]
      } as T;
    if (statuses instanceof Error) throw statuses;
    return statuses as T;
  };

describe('what already failed on a commit', () => {
  test("lists the failed check suites of the task's own branch and failed or errored commit statuses", async () => {
    const failures = await failuresOn(
      answers({
        statuses: [
          { state: 'success', context: 'lint' },
          { state: 'error', context: 'preview', description: 'Build crashed' }
        ]
      }),
      'ViciApp/vici-app',
      commit
    );
    expect(failures).toEqual(['GitHub Actions: failure', 'preview: error (Build crashed)']);
  });

  test('still reads the check suites where the App may not read commit statuses yet', async () => {
    const forbidden = new GitHubError(
      403,
      '/repos/x/commits/abc/status',
      'Resource not accessible'
    );
    expect(await failuresOn(answers(forbidden), 'ViciApp/vici-app', commit)).toEqual([
      'GitHub Actions: failure'
    ]);
    const down = new GitHubError(502, '/repos/x/commits/abc/status', 'Bad gateway');
    expect(failuresOn(answers(down), 'ViciApp/vici-app', commit)).rejects.toThrow('502');
  });
});

import { describe, expect, test } from 'bun:test';
import { GitHubError, failuresOn } from '../src';

const answers =
  (statuses: unknown) =>
  async <T>(path: string): Promise<T> => {
    if (path.endsWith('/check-suites?per_page=100'))
      return {
        check_suites: [
          { conclusion: 'success', app: { name: 'Vercel' } },
          { conclusion: 'failure', app: { name: 'GitHub Actions' } },
          { conclusion: null, app: { name: 'Pending' } }
        ]
      } as T;
    if (statuses instanceof Error) throw statuses;
    return statuses as T;
  };

describe('what already failed on a commit', () => {
  test('lists its failed check suites and failed or errored commit statuses', async () => {
    const failures = await failuresOn(
      answers({
        statuses: [
          { state: 'success', context: 'lint' },
          { state: 'error', context: 'preview', description: 'Build crashed' }
        ]
      }),
      'ViciApp/vici-app',
      'abc'
    );
    expect(failures).toEqual(['GitHub Actions: failure', 'preview: error (Build crashed)']);
  });

  test('still reads the check suites where the App may not read commit statuses yet', async () => {
    const forbidden = new GitHubError(
      403,
      '/repos/x/commits/abc/status',
      'Resource not accessible'
    );
    expect(await failuresOn(answers(forbidden), 'ViciApp/vici-app', 'abc')).toEqual([
      'GitHub Actions: failure'
    ]);
    const down = new GitHubError(502, '/repos/x/commits/abc/status', 'Bad gateway');
    expect(failuresOn(answers(down), 'ViciApp/vici-app', 'abc')).rejects.toThrow('502');
  });
});

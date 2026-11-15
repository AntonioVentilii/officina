import type { AdoptPort, GitHubPort, HandInPort } from '../src';

/** Every GitHub call the engine makes, through any of its ports. */
type EngineGitHub = GitHubPort & AdoptPort & HandInPort;

const unexpected = (method: string) => async (): Promise<never> => {
  throw new Error(`unexpected GitHub call in this test: ${method}`);
};

/**
 * A GitHub port where only the calls a test gives answer, typed against the real client; any other
 * call fails the test, so a fake never has to be cast to the port it stands in for.
 */
export const gitHubWith = (calls: Partial<EngineGitHub>): EngineGitHub => ({
  installationToken: unexpected('installationToken'),
  runToken: unexpected('runToken'),
  revokeToken: unexpected('revokeToken'),
  openPullRequest: unexpected('openPullRequest'),
  refSnapshot: unexpected('refSnapshot'),
  refActivity: unexpected('refActivity'),
  appBotLogin: unexpected('appBotLogin'),
  isPullRequestMerge: unexpected('isPullRequestMerge'),
  isOnBranch: unexpected('isOnBranch'),
  readFile: unexpected('readFile'),
  updateFile: unexpected('updateFile'),
  pushFacts: unexpected('pushFacts'),
  commitChanges: unexpected('commitChanges'),
  commentOnIssue: unexpected('commentOnIssue'),
  mergeWhenReady: unexpected('mergeWhenReady'),
  cancelAutoMerge: unexpected('cancelAutoMerge'),
  pullRequest: unexpected('pullRequest'),
  resolveReviewThreads: unexpected('resolveReviewThreads'),
  failedChecks: unexpected('failedChecks'),
  changeOf: unexpected('changeOf'),
  ...calls
});

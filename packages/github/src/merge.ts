import { GitHubError } from './http';

const ENABLE_AUTO_MERGE =
  'mutation($id: ID!, $head: GitObjectID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $head }) { clientMutationId } }';

/** The two calls a merge needs, made as the App or as a person. */
export interface MergeCalls {
  graphql(
    query: string,
    variables: Record<string, unknown>
  ): Promise<{ errors?: { message: string }[] }>;
  merge(body: { merge_method: 'squash'; sha: string }): Promise<unknown>;
}

/**
 * Turns on auto-merge, so GitHub merges once every branch rule is met. A pull request that already
 * meets them cannot take auto-merge and is merged straight away. Both are pinned to `expectedHead`,
 * so a commit pushed after it was checked never lands with it.
 */
export const mergeWhenReadyWith = async (
  calls: MergeCalls,
  pullRequestNodeId: string,
  expectedHead: string
): Promise<'auto_merge' | 'merged'> => {
  const response = await calls.graphql(ENABLE_AUTO_MERGE, {
    id: pullRequestNodeId,
    head: expectedHead
  });
  if (!response.errors?.length) return 'auto_merge';
  const message = response.errors.map((error) => error.message).join('; ');
  if (!/clean status|is in clean/i.test(message)) {
    throw new GitHubError(422, '/graphql enablePullRequestAutoMerge', message);
  }
  await calls.merge({ merge_method: 'squash', sha: expectedHead });
  return 'merged';
};

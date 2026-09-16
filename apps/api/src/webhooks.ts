import { parseProjectConfigYaml, type Actor, type Command } from '@officina/core';
import {
  applyCommand,
  findProjectsByRepo,
  findTasksByPullRequest,
  updateProjectConfig
} from '@officina/db';
import type { GitHubClient, WebhookAction } from '@officina/github';
import type { Pool } from 'pg';

export const CONFIG_PATH = '.github/officina.yml';

export type WebhookOutcome =
  | { readonly taskId: string; readonly ok: boolean; readonly error?: string }
  | {
      readonly projectId: string;
      readonly config: 'updated' | 'invalid' | 'missing';
      readonly errors?: readonly string[];
    };

export type ConfigReader = Pick<GitHubClient, 'fileContent'>;

const ENGINE: Actor = { kind: 'engine' };

/**
 * A push to a project's default branch that touches its config refreshes the stored config. An
 * invalid or deleted config is reported and the last valid one stays in force.
 */
const refreshConfigs = async (
  pool: Pool,
  github: ConfigReader | undefined,
  action: Extract<WebhookAction, { kind: 'push' }>
): Promise<WebhookOutcome[]> => {
  if (!github || !action.changedPaths.includes(CONFIG_PATH)) return [];
  const outcomes: WebhookOutcome[] = [];
  for (const project of await findProjectsByRepo(pool, action.repo)) {
    if (project.defaultBranch !== action.branch || project.installationId === null) continue;
    const text = await github.fileContent({
      installationId: project.installationId,
      repo: project.repo,
      path: CONFIG_PATH,
      branch: project.defaultBranch
    });
    if (text === null) {
      outcomes.push({ projectId: project.id, config: 'missing' });
      continue;
    }
    const parsed = parseProjectConfigYaml(text);
    if (!parsed.ok) {
      outcomes.push({ projectId: project.id, config: 'invalid', errors: parsed.errors });
      continue;
    }
    await updateProjectConfig(pool, project.id, Bun.YAML.parse(text));
    outcomes.push({ projectId: project.id, config: 'updated' });
  }
  return outcomes;
};

/**
 * Applies a GitHub fact. Pull request outcomes go to every linked task; a rejection such as
 * `wrong_stage` (CI failing while a task is still in review) is reported rather than raised.
 */
export const handleWebhookAction = async (
  pool: Pool,
  action: WebhookAction,
  github?: ConfigReader
): Promise<WebhookOutcome[]> => {
  if (action.kind === 'push') return refreshConfigs(pool, github, action);

  const targets: { prNumber: number; command: Command }[] =
    action.kind === 'pull_request_merged'
      ? [{ prNumber: action.prNumber, command: { type: 'merged' } }]
      : action.prNumbers.map((prNumber) => ({
          prNumber,
          command: { type: 'ci_failed', details: action.details }
        }));

  const outcomes: WebhookOutcome[] = [];
  for (const { prNumber, command } of targets) {
    for (const taskId of await findTasksByPullRequest(pool, action.repo, prNumber)) {
      const result = await applyCommand(pool, { taskId, command, actor: ENGINE });
      outcomes.push(result.ok ? { taskId, ok: true } : { taskId, ok: false, error: result.error });
    }
  }
  return outcomes;
};

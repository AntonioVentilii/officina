import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createGitHubClient } from '@officina/github';
import { Pool } from 'pg';
import { createAgentsPort } from './engine';
import { SetupError, addProject, setupAgents } from './setup';

const USAGE = `usage:
  bun apps/api/src/cli.ts setup-agents
  bun apps/api/src/cli.ts add-project --workspace <name> --repo <owner/name> --owner-email <email> --owner-name <name> [--config-file <path>]

Reads DATABASE_URL, ANTHROPIC_API_KEY, GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY from the environment.`;

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new SetupError(`${name} is not set`);
  return value;
};

const PROMPTS_DIR = join(import.meta.dir, '..', '..', '..', 'agents');

const main = async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: 'string' },
      repo: { type: 'string' },
      'owner-email': { type: 'string' },
      'owner-name': { type: 'string' },
      'config-file': { type: 'string' }
    }
  });
  const command = positionals[0];
  if (command !== 'setup-agents' && command !== 'add-project') {
    console.error(USAGE);
    process.exit(2);
  }

  const pool = new Pool({ connectionString: required('DATABASE_URL') });
  const agents = createAgentsPort(required('ANTHROPIC_API_KEY'));
  try {
    if (command === 'setup-agents') {
      const { changed } = await setupAgents(pool, agents, PROMPTS_DIR);
      console.log(
        changed.length ? `agents created or updated: ${changed.join(', ')}` : 'agents up to date'
      );
      return;
    }
    const {
      workspace,
      repo,
      'owner-email': email,
      'owner-name': name,
      'config-file': configFile
    } = values;
    if (!workspace || !repo || !email || !name) throw new SetupError(USAGE);
    const github = createGitHubClient({
      appId: required('GITHUB_APP_ID'),
      privateKeyPem: required('GITHUB_APP_PRIVATE_KEY')
    });
    const result = await addProject(
      pool,
      { github, agents },
      {
        workspace,
        repo,
        owner: { email, name },
        ...(configFile ? { configYaml: await Bun.file(configFile).text() } : {})
      }
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
};

main().catch((error: Error) => {
  console.error(error instanceof SetupError ? error.message : error);
  process.exit(1);
});

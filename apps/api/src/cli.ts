import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createGitHubClient } from '@officina/github';
import { anthropicAuthFrom } from '@officina/runner';
import { Pool } from 'pg';
import { createAgentsPort } from './engine';
import { SetupError, addProject, setupAgents } from './setup';
import {
  TaskCommandError,
  actOnTask,
  createRequest,
  describeTask,
  listTasksText,
  type TaskAction
} from './tasks';

const USAGE = `usage (on your machine, prefix with scripts/officina; on the server, with bun apps/api/src/cli.ts):

  Tasks
    task list
    task show     --number <n>
    task create   --title "<title>" --request "<what you want, in plain words>"
    task accept   --number <n>
    task approve  --number <n>
    task changes  --number <n> --note "<what to change>"
    task answer   --number <n> --text "<answer to the open question>"
    task decline  --number <n> --reason "<why>"
    task cancel   --number <n> --reason "<why>"

    Every task command also takes --repo <owner/name> (optional with a single project)
    and --as <email> (defaults to the project owner).

  Setup
    setup-agents
    add-project --workspace <name> --repo <owner/name> --owner-email <email> --owner-name <name> [--config-file <path>]`;

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new SetupError(`${name} is not set`);
  return value;
};

const PROMPTS_DIR = join(import.meta.dir, '..', '..', '..', 'agents');

/**
 * Arguments may arrive base64-encoded as one JSON array (`--b64 <data>`), which is how the local
 * wrapper passes text with spaces and quotes through a remote shell without any quoting surprises.
 */
export const decodeArgs = (argv: readonly string[]): string[] =>
  argv[0] === '--b64' && argv[1]
    ? (JSON.parse(Buffer.from(argv[1], 'base64').toString('utf8')) as string[])
    : [...argv];

const agentsPort = () => {
  const auth = anthropicAuthFrom(process.env);
  if (!auth) {
    throw new SetupError(
      'set ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID and ANTHROPIC_SERVICE_ACCOUNT_ID (or ANTHROPIC_API_KEY)'
    );
  }
  return createAgentsPort(auth);
};

const main = async () => {
  const { positionals, values } = parseArgs({
    args: decodeArgs(Bun.argv.slice(2)),
    allowPositionals: true,
    options: {
      workspace: { type: 'string' },
      repo: { type: 'string' },
      'owner-email': { type: 'string' },
      'owner-name': { type: 'string' },
      'config-file': { type: 'string' },
      number: { type: 'string' },
      title: { type: 'string' },
      request: { type: 'string' },
      note: { type: 'string' },
      text: { type: 'string' },
      reason: { type: 'string' },
      as: { type: 'string' }
    }
  });
  const [command, subcommand] = positionals;
  const pool = new Pool({ connectionString: required('DATABASE_URL') });
  const need = (value: string | undefined, flag: string): string => {
    if (!value) throw new TaskCommandError(`missing --${flag}\n\n${USAGE}`);
    return value;
  };
  const number = () => {
    const parsed = Number(need(values.number, 'number'));
    if (!Number.isInteger(parsed) || parsed < 1)
      throw new TaskCommandError('--number must be a task number');
    return parsed;
  };
  const target = { repo: values.repo, asEmail: values.as };

  try {
    if (command === 'task') {
      switch (subcommand) {
        case 'list':
          console.log(await listTasksText(pool, target));
          return;
        case 'show':
          console.log(
            await describeTask(pool, {
              ...target,
              number: number(),
              consoleWorkspace: process.env.ANTHROPIC_WORKSPACE_ID
            })
          );
          return;
        case 'create': {
          const created = await createRequest(pool, {
            ...target,
            title: need(values.title, 'title'),
            request: need(values.request, 'request')
          });
          console.log(
            `Created task #${created.number} (${created.stage}). Next: task accept --number ${created.number}`
          );
          return;
        }
        case 'accept':
        case 'approve':
        case 'changes':
        case 'answer':
        case 'decline':
        case 'cancel': {
          const action: TaskAction =
            subcommand === 'changes'
              ? { type: 'changes', note: need(values.note, 'note') }
              : subcommand === 'answer'
                ? { type: 'answer', text: need(values.text, 'text') }
                : subcommand === 'decline' || subcommand === 'cancel'
                  ? { type: subcommand, reason: need(values.reason, 'reason') }
                  : { type: subcommand };
          const result = await actOnTask(pool, { ...target, number: number(), action });
          const approval =
            result.satisfied === false
              ? ' Approval recorded; more approvals are still needed.'
              : '';
          console.log(
            `Task #${values.number}: ${subcommand} done, now ${result.stage}.${approval}`
          );
          return;
        }
        default:
          throw new TaskCommandError(USAGE);
      }
    }

    if (command === 'setup-agents') {
      const { changed } = await setupAgents(pool, agentsPort(), PROMPTS_DIR);
      console.log(
        changed.length ? `agents created or updated: ${changed.join(', ')}` : 'agents up to date'
      );
      return;
    }

    if (command === 'add-project') {
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
        { github, agents: agentsPort() },
        {
          workspace,
          repo,
          owner: { email, name },
          ...(configFile ? { configYaml: await Bun.file(configFile).text() } : {})
        }
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    throw new TaskCommandError(USAGE);
  } finally {
    await pool.end();
  }
};

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(
      error instanceof SetupError || error instanceof TaskCommandError ? error.message : error
    );
    process.exit(1);
  });
}

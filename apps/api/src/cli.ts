import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createGitHubClient } from '@officina/github';
import { anthropicAuthFrom, createModelResolver } from '@officina/runner';
import { Pool } from 'pg';
import { createAgentsPort } from './engine';
import { invite, loginLink, membersText } from './people';
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
    task create   --title "<title>" --request "<what you want, in plain words>" [--skip-interview]
    task submit   --number <n>                 send a request to triage without more questions
    task accept   --number <n>
    task approve  --number <n>
    task changes  --number <n> --note "<what to change>"
    task answer   --number <n> --text "<answer to the open question>"
    task decline  --number <n> --reason "<why>"
    task cancel   --number <n> --reason "<why>"

    Every task command also takes --repo <owner/name> (optional with a single project)
    and --as <email> (defaults to the project owner).

  People
    login-link    [--email <email>]          one-time sign-in link to the board, valid 30 minutes
    invite        --email <email> --name "<name>" --role watcher|contributor|maintainer|owner
                  [--domains product,legal]  adds or updates a member; the link is valid 7 days
    members                                  who is in the project, when they joined, whether their
                                             latest link was used, when they were last seen and
                                             whether they connected Claude

    People commands also take --repo <owner/name> (optional with a single project).

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
      as: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string' },
      domains: { type: 'string' },
      'skip-interview': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  // `scripts/officina` with no arguments asks for this; it needs no database.
  if (values.help) {
    console.log(USAGE);
    return;
  }
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
            request: need(values.request, 'request'),
            skipInterview: values['skip-interview']
          });
          console.log(
            created.stage === 'request'
              ? `Created task #${created.number}. The interviewer asks follow-up questions first: answer with task answer --number ${created.number} --text "...", or skip with task submit --number ${created.number}.`
              : `Created task #${created.number} (${created.stage}). Next: task accept --number ${created.number}`
          );
          return;
        }
        case 'submit':
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

    if (command === 'login-link') {
      console.log(
        await loginLink(pool, {
          publicUrl: required('OFFICINA_PUBLIC_URL'),
          email: values.email,
          repo: values.repo
        })
      );
      return;
    }

    if (command === 'members') {
      console.log(await membersText(pool, { repo: values.repo }));
      return;
    }

    if (command === 'invite') {
      console.log(
        await invite(pool, {
          publicUrl: required('OFFICINA_PUBLIC_URL'),
          email: need(values.email, 'email'),
          name: need(values.name, 'name'),
          role: need(values.role, 'role'),
          domains: (values.domains ?? '')
            .split(',')
            .map((domain) => domain.trim())
            .filter(Boolean),
          repo: values.repo
        })
      );
      return;
    }

    if (command === 'setup-agents') {
      const port = agentsPort();
      const model = await createModelResolver({
        listModels: () => port.listModels(),
        env: process.env,
        log: (message, details) => console.log(message, JSON.stringify(details ?? {}))
      }).resolve('opus');
      const { changed } = await setupAgents(pool, port, PROMPTS_DIR, model.id);
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
      if (result.onboardingTask !== null) {
        console.log(
          `agent docs missing on the default branch: ${result.missingDocs.join(', ')}. Task ${result.onboardingTask} writes them; no other task is built until it is merged.`
        );
      }
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

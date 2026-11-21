import { parseArgs } from 'node:util';
import { createGitHubClient } from '@officina/github';
import {
  PROMPTS_DIR,
  anthropicAuthFrom,
  createModelResolver,
  resolveTiers
} from '@officina/runner';
import { Pool } from 'pg';
import { createAgentsPort } from './engine';
import { USAGE } from './cli-usage';
import { accessLogText, invite, loginLink, membersText } from './people';
import { SetupError, addProject, setupAgents } from './setup';
import {
  TaskCommandError,
  actOnTask,
  createRequest,
  describeTask,
  handIn,
  linkTask,
  listTasksText,
  type TaskAction
} from './tasks';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new SetupError(`${name} is not set`);
  return value;
};

/**
 * Arguments may arrive base64-encoded as one JSON array (`--b64 <data>`), which is how the local
 * wrapper passes text with spaces and quotes through a remote shell without any quoting surprises.
 */
export const decodeArgs = (argv: readonly string[]): string[] =>
  argv[0] === '--b64' && argv[1]
    ? (JSON.parse(Buffer.from(argv[1], 'base64').toString('utf8')) as string[])
    : [...argv];

const need = (value: string | undefined, flag: string): string => {
  if (!value) throw new TaskCommandError(`missing --${flag}\n\n${USAGE}`);
  return value;
};

/** The flags a task action may carry, as the command line gave them. */
interface ActionFlags {
  readonly note?: string | undefined;
  readonly text?: string | undefined;
  readonly reason?: string | undefined;
  readonly option?: string | undefined;
  readonly version?: string | undefined;
}

/** An answer in words, or an option picked from the question as `task show` gave it. */
const answerFor = (flags: ActionFlags): TaskAction => {
  if (flags.option === undefined) return { type: 'answer', text: need(flags.text, 'text') };
  const version = Number(need(flags.version, 'version'));
  if (!Number.isInteger(version) || version < 1)
    throw new TaskCommandError('--version must be the version task show gives with the options');
  return { type: 'answer', text: flags.text ?? '', option: flags.option, version };
};

/** The decision a `task` subcommand applies, or null for a subcommand that applies none. */
export const taskActionFor = (
  subcommand: string | undefined,
  flags: ActionFlags
): TaskAction | null => {
  switch (subcommand) {
    case 'submit':
    case 'accept':
    case 'claim':
    case 'approve':
      return { type: subcommand };
    case 'hand-back':
      return { type: 'release' };
    case 'changes':
      return { type: 'changes', note: need(flags.note, 'note') };
    case 'answer':
      return answerFor(flags);
    case 'decline':
    case 'cancel':
      return { type: subcommand, reason: need(flags.reason, 'reason') };
    default:
      return null;
  }
};

/** A task number a flag names, refused unless it is a positive integer. */
const taskNumber = (value: string, flag: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new TaskCommandError(`--${flag} must be a task number`);
  return parsed;
};

const agentsPort = () => {
  const auth = anthropicAuthFrom(process.env);
  if (!auth) {
    throw new SetupError(
      'set ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID and ANTHROPIC_SERVICE_ACCOUNT_ID (or ANTHROPIC_API_KEY)'
    );
  }
  return createAgentsPort(auth);
};

/** The GitHub App's client, for the commands that read or write GitHub. */
const githubClient = () =>
  createGitHubClient({
    appId: required('GITHUB_APP_ID'),
    privateKeyPem: required('GITHUB_APP_PRIVATE_KEY')
  });

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
      body: { type: 'string' },
      request: { type: 'string' },
      note: { type: 'string' },
      text: { type: 'string' },
      reason: { type: 'string' },
      option: { type: 'string' },
      version: { type: 'string' },
      as: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string' },
      domains: { type: 'string' },
      checked: { type: 'string', multiple: true },
      parent: { type: 'string' },
      after: { type: 'string', multiple: true },
      'skip-interview': { type: 'boolean' },
      interview: { type: 'boolean' },
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
  const number = () => taskNumber(need(values.number, 'number'), 'number');
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
            skipInterview: values['skip-interview'] || (values.interview ? false : undefined)
          });
          console.log(
            created.stage === 'request'
              ? `Created task #${created.number}. The interviewer asks follow-up questions first: answer with task answer --number ${created.number} --text "...", or skip with task submit --number ${created.number}.`
              : `Created task #${created.number} (${created.stage}). Next: task accept --number ${created.number}`
          );
          return;
        }
        case 'link':
          console.log(
            await linkTask(pool, {
              ...target,
              number: number(),
              parent: values.parent === undefined ? undefined : taskNumber(values.parent, 'parent'),
              after: (values.after ?? []).map((value) => taskNumber(value, 'after'))
            })
          );
          return;
        case 'hand-in': {
          const handedIn = await handIn(pool, githubClient(), {
            ...target,
            number: number(),
            prTitle: need(values.title, 'title'),
            prBody: values.body,
            verified: values.checked ?? [],
            notVerified: [],
            publicUrl: required('OFFICINA_PUBLIC_URL')
          });
          console.log(
            `Task #${values.number} handed in, now ${handedIn.stage}${handedIn.pullRequest ? `, pull request #${handedIn.pullRequest}` : ''}.`
          );
          return;
        }
        default: {
          const action = taskActionFor(subcommand, values);
          if (!action) throw new TaskCommandError(USAGE);
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

    if (command === 'access-log') {
      console.log(await accessLogText(pool, { repo: values.repo }));
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
      const models = await resolveTiers(
        createModelResolver({
          listModels: () => port.listModels(),
          env: process.env,
          log: (message, details) => console.log(message, JSON.stringify(details ?? {}))
        })
      );
      const { changed } = await setupAgents(pool, port, PROMPTS_DIR, models);
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
      const result = await addProject(
        pool,
        { github: githubClient(), agents: agentsPort() },
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
          `agent docs missing on the default branch: ${result.missingDocs.join(', ')}. Task ${result.onboardingTask} writes them; no other task is built until it is merged or cancelled.`
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

import { migrate } from '@officina/db';
import { createGitHubAsUser, createGitHubClient, createGitHubUserAuth } from '@officina/github';
import { anthropicAuthFrom, createModelResolver } from '@officina/runner';
import { join } from 'node:path';
import { Pool } from 'pg';
import { z } from 'zod';
import { createApp } from './app';
import { LOOPBACK_HOSTS } from './connector';
import { createAgentsPort, startEngine } from './engine';
import { createGitHubAccounts } from './github-accounts';
import { startRealtime } from './realtime';
import type { Scheduler } from './scheduler';
import { createTokenBox } from './token-box';

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    GITHUB_WEBHOOK_SECRET: z.string().min(32),
    PORT: z.coerce.number().int().positive().default(8080),
    GITHUB_APP_ID: z.string().min(1).optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
    // Workload identity federation: public identifiers, no stored key. Falls back to an API key.
    ANTHROPIC_FEDERATION_RULE_ID: z.string().min(1).optional(),
    ANTHROPIC_ORGANIZATION_ID: z.string().min(1).optional(),
    ANTHROPIC_SERVICE_ACCOUNT_ID: z.string().min(1).optional(),
    ANTHROPIC_WORKSPACE_ID: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    // Pins the agents' model; unset, they run the newest Opus the Models API lists.
    ANTHROPIC_MODEL: z.string().min(1).optional(),
    SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    // Sign-in cookies, OAuth codes and the connector's tokens travel to this address, so anything
    // but the local machine must be https.
    OFFICINA_PUBLIC_URL: z
      .url()
      .default('http://localhost:8080')
      .refine(
        (value) => value.startsWith('https://') || LOOPBACK_HOSTS.has(new URL(value).hostname),
        'OFFICINA_PUBLIC_URL must be https unless it is localhost'
      ),
    // GitHub user authorization: members link their account, and a verification can approve and
    // merge as them. Off unless both the client secret and the token encryption key are set.
    GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
    OFFICINA_TOKEN_KEY: z.string().min(1).optional()
  })
  .parse(process.env);

const log = (message: string, details?: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...details }));

const pool = new Pool({ connectionString: env.DATABASE_URL });

const client = await pool.connect();
try {
  const applied = await migrate(client);
  if (applied.length) log('migrations applied', { applied });
} finally {
  client.release();
}

const github =
  env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY
    ? createGitHubClient({ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY })
    : undefined;

const anthropicAuth = anthropicAuthFrom(process.env);

const githubUserAuth =
  env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET && env.OFFICINA_TOKEN_KEY
    ? createGitHubUserAuth({
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
        redirectUri: `${env.OFFICINA_PUBLIC_URL.replace(/\/$/, '')}/auth/github/callback`
      })
    : undefined;
const asUser = createGitHubAsUser();
const githubAccounts =
  githubUserAuth && env.OFFICINA_TOKEN_KEY
    ? createGitHubAccounts({
        pool,
        box: createTokenBox(env.OFFICINA_TOKEN_KEY),
        auth: githubUserAuth,
        asUser
      })
    : undefined;

const agents = anthropicAuth
  ? createAgentsPort(anthropicAuth, (error) =>
      log('anthropic credentials refresh failed, keeping cached token', {
        error: (error as Error).message
      })
    )
  : undefined;

const realtime = await startRealtime({ connectionString: env.DATABASE_URL, pool, log });

const server = createApp({
  pool,
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  ...(github ? { github } : {}),
  board: {
    publicUrl: env.OFFICINA_PUBLIC_URL,
    consoleWorkspace: env.ANTHROPIC_WORKSPACE_ID,
    realtime,
    github,
    builds: github,
    githubLogin:
      githubAccounts && githubUserAuth
        ? { accounts: githubAccounts, authorizeUrl: githubUserAuth.authorizeUrl }
        : undefined
  },
  boardDir: join(import.meta.dir, '..', '..', 'board', 'build')
}).listen({
  port: env.PORT,
  hostname: '0.0.0.0'
});
log('api listening', { port: env.PORT, engine: Boolean(github && agents) });

let scheduler: Scheduler | undefined;

const shutdown = async (signal: string) => {
  log('shutting down', { signal });
  await scheduler?.stop();
  await server.stop();
  await realtime.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Started after the server listens: the boot sync talks to Anthropic, and an outage there must
// not take the health check and the board down with it.
scheduler =
  github && agents
    ? await startEngine({
        pool,
        github,
        agents,
        models: createModelResolver({
          listModels: () => agents.listModels(),
          env: { ANTHROPIC_MODEL: env.ANTHROPIC_MODEL },
          log
        }),
        intervalMs: env.SCHEDULER_INTERVAL_MS,
        publicUrl: env.OFFICINA_PUBLIC_URL,
        promptsDir: join(import.meta.dir, '..', '..', '..', 'agents'),
        onBehalf: githubAccounts
          ? { publicUrl: env.OFFICINA_PUBLIC_URL, tokenFor: githubAccounts.tokenFor, asUser }
          : undefined,
        log
      })
    : undefined;

if (scheduler) {
  log('anthropic credentials', { mode: anthropicAuth?.kind });
} else {
  const missing = [
    !env.GITHUB_APP_ID && 'GITHUB_APP_ID',
    !env.GITHUB_APP_PRIVATE_KEY && 'GITHUB_APP_PRIVATE_KEY',
    !anthropicAuth &&
      'ANTHROPIC_FEDERATION_RULE_ID (with organization and service account) or ANTHROPIC_API_KEY'
  ].filter(Boolean);
  log('engine disabled', { missing });
}

import { migrate } from '@officina/db';
import { createGitHubClient } from '@officina/github';
import { anthropicAuthFrom } from '@officina/runner';
import { Pool } from 'pg';
import { z } from 'zod';
import { createApp } from './app';
import { createAgentsPort, startEngine } from './engine';

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
    SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    OFFICINA_PUBLIC_URL: z.url().default('http://localhost:8080')
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

const scheduler =
  github && anthropicAuth
    ? await startEngine({
        pool,
        github,
        agents: createAgentsPort(anthropicAuth, (error) =>
          log('anthropic credentials refresh failed, keeping cached token', {
            error: (error as Error).message
          })
        ),
        intervalMs: env.SCHEDULER_INTERVAL_MS,
        publicUrl: env.OFFICINA_PUBLIC_URL,
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

const server = createApp({
  pool,
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  ...(github ? { github } : {})
}).listen({
  port: env.PORT,
  hostname: '0.0.0.0'
});
log('api listening', { port: env.PORT, engine: Boolean(scheduler) });

const shutdown = async (signal: string) => {
  log('shutting down', { signal });
  await scheduler?.stop();
  await server.stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

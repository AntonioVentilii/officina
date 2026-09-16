import { migrate } from '@officina/db';
import { Pool } from 'pg';
import { z } from 'zod';
import { createApp } from './app';

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    GITHUB_WEBHOOK_SECRET: z.string().min(32),
    PORT: z.coerce.number().int().positive().default(8080)
  })
  .parse(process.env);

const pool = new Pool({ connectionString: env.DATABASE_URL });

const client = await pool.connect();
try {
  const applied = await migrate(client);
  if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);
} finally {
  client.release();
}

createApp({ pool, webhookSecret: env.GITHUB_WEBHOOK_SECRET }).listen({
  port: env.PORT,
  hostname: '0.0.0.0'
});
console.log(`officina api listening on ${env.PORT}`);

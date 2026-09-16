import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');

/** Applies pending migrations in filename order, each in its own transaction. Returns the applied names. */
export const migrate = async (client: Client): Promise<string[]> => {
  await client.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`
  );
  const done = new Set(
    (await client.query<{ name: string }>('select name from schema_migrations')).rows.map(
      (row) => row.name
    )
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await Bun.file(join(MIGRATIONS_DIR, file)).text();
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${(error as Error).message}`);
    }
    applied.push(file);
  }
  return applied;
};

if (import.meta.main) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const applied = await migrate(client);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
  } finally {
    await client.end();
  }
}

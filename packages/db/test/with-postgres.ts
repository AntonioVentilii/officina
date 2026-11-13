/**
 * Runs the database tests. With `TEST_DATABASE_URL` set (CI's service container) they run against
 * it; otherwise against a throwaway Postgres container, removed afterwards.
 */
const SUITES = ['packages/db', 'packages/engine', 'apps/api'];
const name = `officina-test-${process.pid}`;
const port = 55_432;

const run = async (cmd: string[], quiet = false) => {
  const proc = Bun.spawn(cmd, { stdout: quiet ? 'ignore' : 'inherit', stderr: 'inherit' });
  return proc.exited;
};

const runSuites = (url: string) =>
  Bun.spawn(['bun', 'test', ...SUITES], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, TEST_DATABASE_URL: url }
  }).exited;

const withContainer = async (): Promise<number> => {
  await run(
    [
      'docker',
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-p',
      `${port}:5432`,
      'postgres:17-alpine'
    ],
    true
  );
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
      ready = (await run(['docker', 'exec', name, 'pg_isready', '-U', 'postgres'], true)) === 0;
      if (!ready) await Bun.sleep(500);
    }
    if (!ready) throw new Error('postgres did not become ready');
    // pg_isready passes before the init script restarts the server; give it a moment.
    await Bun.sleep(1500);
    return await runSuites(`postgres://postgres@localhost:${port}/postgres`);
  } finally {
    await run(['docker', 'rm', '-f', name], true);
  }
};

const given = process.env.TEST_DATABASE_URL;
process.exitCode = given ? await runSuites(given) : await withContainer();

export {};

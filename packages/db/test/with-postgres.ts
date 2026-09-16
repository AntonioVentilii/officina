/** Runs the database tests against a throwaway Postgres container, then removes it. */
const name = `officina-test-${process.pid}`;
const port = 55_432;

const run = async (cmd: string[], quiet = false) => {
  const proc = Bun.spawn(cmd, { stdout: quiet ? 'ignore' : 'inherit', stderr: 'inherit' });
  return proc.exited;
};

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

  const exitCode = await Bun.spawn(['bun', 'test', 'packages/db'], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      TEST_DATABASE_URL: `postgres://postgres@localhost:${port}/postgres`
    }
  }).exited;
  process.exitCode = exitCode;
} finally {
  await run(['docker', 'rm', '-f', name], true);
}

export {};

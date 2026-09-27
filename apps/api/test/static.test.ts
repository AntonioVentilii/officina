import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoardServer } from '../src/static';

describe('board static server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-'));
  await mkdir(join(dir, '_app', 'immutable'), { recursive: true });
  await writeFile(join(dir, 'index.html'), '<html>shell</html>');
  await writeFile(join(dir, '_app', 'immutable', 'app.js'), 'console.log(1)');
  const serve = createBoardServer(dir);

  test('client routes get the app shell, which may not be framed', async () => {
    const response = await serve('/tasks/12');
    expect(await response.text()).toBe('<html>shell</html>');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  test('hashed assets are cached for good', async () => {
    const response = await serve('/_app/immutable/app.js');
    expect(await response.text()).toBe('console.log(1)');
    expect(response.headers.get('cache-control')).toContain('immutable');
  });

  test('API paths and paths outside the build never get the shell or a file', async () => {
    expect((await serve('/api/nope')).status).toBe(404);
    expect(await (await serve('/../../etc/passwd')).text()).toBe('<html>shell</html>');
    expect(await (await serve('/%2e%2e/%2e%2e/etc/passwd')).text()).toBe('<html>shell</html>');
  });
});

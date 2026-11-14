import { describe, expect, test } from 'bun:test';
import { decodeArgs } from '../src/cli';

describe('cli arguments', () => {
  test('base64-encoded arguments arrive exactly as typed, spaces, quotes and accents included', () => {
    const typed = [
      'task',
      'create',
      '--title',
      'Replace "Wager"',
      '--request',
      "It's the rule: prediction, never bet. Città"
    ];
    const encoded = Buffer.from(JSON.stringify(typed)).toString('base64');
    expect(decodeArgs(['--b64', encoded])).toEqual(typed);
  });

  test('plain arguments pass through', () => {
    expect(decodeArgs(['task', 'list'])).toEqual(['task', 'list']);
  });

  test('--help prints the usage without a database, as scripts/officina asks with no arguments', async () => {
    const encoded = Buffer.from(JSON.stringify(['--help'])).toString('base64');
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const run = Bun.spawn(['bun', `${import.meta.dir}/../src/cli.ts`, '--b64', encoded], {
      env,
      stdout: 'pipe',
      stderr: 'pipe'
    });
    expect(await run.exited).toBe(0);
    expect(await new Response(run.stdout).text()).toStartWith('usage');
  });
});

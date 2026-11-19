import { describe, expect, test } from 'bun:test';
import { decodeArgs, taskActionFor } from '../src/cli';

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
    const usage = await new Response(run.stdout).text();
    expect(usage).toStartWith('usage');
    expect(usage).toContain('one-time sign-in link to the board, valid 30 minutes');
    expect(usage).toContain('the link is valid 7 days');
  });

  test('each task subcommand applies its decision, and hand-back is the lifecycle release', () => {
    expect(taskActionFor('hand-back', {})).toEqual({ type: 'release' });
    expect(taskActionFor('claim', {})).toEqual({ type: 'claim' });
    expect(taskActionFor('cancel', { reason: 'Not now.' })).toEqual({
      type: 'cancel',
      reason: 'Not now.'
    });
    expect(() => taskActionFor('changes', {})).toThrow('missing --note');
    expect(taskActionFor('release', {})).toBeNull();
    expect(taskActionFor('list', {})).toBeNull();
  });

  test('an answer is words, or an option picked with the version it was read at', () => {
    expect(taskActionFor('answer', { text: 'Split it.' })).toEqual({
      type: 'answer',
      text: 'Split it.'
    });
    expect(taskActionFor('answer', { option: 'c', version: '7' })).toEqual({
      type: 'answer',
      text: '',
      option: 'c',
      version: 7
    });
    expect(() => taskActionFor('answer', { option: 'c' })).toThrow('missing --version');
    expect(() => taskActionFor('answer', { option: 'c', version: 'seven' })).toThrow('--version');
    expect(() => taskActionFor('answer', {})).toThrow('missing --text');
  });
});

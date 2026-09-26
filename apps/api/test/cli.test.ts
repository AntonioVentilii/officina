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
});

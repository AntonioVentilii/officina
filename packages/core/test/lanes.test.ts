import { describe, expect, test } from 'bun:test';
import { computeLane, redPaths, stricterLane } from '../src';
import { loadConfig } from './fixtures';

const matcher = loadConfig().laneMatcher;

describe('lanes', () => {
  test('any red path makes the change red', () => {
    expect(
      computeLane(['src/lib/constants/messages/en.ts', 'src/satellite/index.ts'], matcher)
    ).toBe('red');
    expect(redPaths(['README.md', '.github/workflows/ci.yml'], matcher)).toEqual([
      '.github/workflows/ci.yml'
    ]);
  });

  test('green only when every path is green', () => {
    expect(
      computeLane(['src/lib/constants/messages/en.ts', 'src/lib/constants/messages/it.ts'], matcher)
    ).toBe('green');
    expect(
      computeLane(['src/lib/constants/messages/en.ts', 'src/routes/+page.svelte'], matcher)
    ).toBe('standard');
  });

  test('an empty change is never green', () => {
    expect(computeLane([], matcher)).toBe('standard');
  });

  test('stricter lane wins in both argument orders', () => {
    expect(stricterLane('green', 'red')).toBe('red');
    expect(stricterLane('standard', 'green')).toBe('standard');
  });
});

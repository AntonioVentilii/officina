/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { returnPath } from '../src/lib/return-path';

const ORIGIN = 'https://officina.example';

describe('returnPath', () => {
  test('a path on this site is kept as the browser resolves it', () => {
    expect(returnPath('/tasks/3?tab=log#run', ORIGIN)).toBe('/tasks/3?tab=log#run');
    expect(returnPath('/a/../members', ORIGIN)).toBe('/members');
  });

  test('anything that would leave this site goes home instead', () => {
    for (const elsewhere of [
      '',
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/.//evil.example',
      '/./\\evil.example',
      '/..//evil.example',
      '/a/..//evil.example',
      '/%2e//evil.example'
    ]) {
      expect(returnPath(elsewhere, ORIGIN)).toBe('/');
    }
  });
});

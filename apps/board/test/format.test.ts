// The board's own types are the browser's; its tests run under Bun.
/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { ago, duration, since } from '../src/lib/format';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe('relative times', () => {
  test('ago says how long ago a time passed', () => {
    expect(ago(at(-5 * 60_000), NOW)).toBe('5 minutes ago');
    expect(ago(at(-26 * 3_600_000), NOW)).toBe('yesterday');
    expect(ago(at(-10_000), NOW)).toBe('just now');
    expect(ago(null, NOW)).toBe('');
  });

  test('a time the browser clock has not reached yet reads just now, never the future', () => {
    expect(ago(at(2 * 60_000), NOW)).toBe('just now');
    expect(ago(at(3 * 86_400_000), NOW)).toBe('just now');
    expect(since(at(2 * 60_000), NOW)).toBe('now');
    expect(duration(at(2 * 60_000), null, NOW)).toBe('0s');
  });
});

/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { CLOSING_SENTENCES } from '../src/lib/closing';
import { dateTime } from '../src/lib/format';

describe('CLOSING_SENTENCES', () => {
  test('a closed task says how it closed and why', () => {
    const closed = CLOSING_SENTENCES.closed!;
    expect(closed({ stage: 'declined', reason: 'Out of scope' })).toBe('declined it: Out of scope');
    expect(closed({ stage: 'cancelled', reason: 'Not now' })).toBe('cancelled it: Not now');
    expect(closed({ stage: 'done', reason: 'Checked on main' })).toBe(
      'closed it as done: Checked on main'
    );
  });

  test('an early merge names who merged it and when, and leaves out what GitHub did not say', () => {
    const merged = CLOSING_SENTENCES.pull_request_merged_early!;
    const at = '2026-11-20T12:35:07Z';
    expect(merged({ pullRequest: 42, by: 'octo-owner', at, stage: 'reviewing' })).toBe(
      `found pull request #42 merged on GitHub by @octo-owner at ${dateTime(at)}, before people verified it`
    );
    expect(merged({ pullRequest: 42, by: null, at: null, stage: 'reviewing' })).toBe(
      'found pull request #42 merged on GitHub, before people verified it'
    );
  });
});

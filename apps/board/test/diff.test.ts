// The board's own types are the browser's; its tests run under Bun.
/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { editLines, type EditLine } from '../src/lib/diff';

const context = (text: string): EditLine => ({ kind: 'context', text });
const removed = (text: string): EditLine => ({ kind: 'removed', text });
const added = (text: string): EditLine => ({ kind: 'added', text });

describe('the lines of a learning edit', () => {
  test('an edit with nothing to find is all added lines', () => {
    expect(editLines(null, 'Check every locale.\nAsk when unsure.\n')).toEqual([
      added('Check every locale.'),
      added('Ask when unsure.')
    ]);
  });

  test('the lines both share at the start and the end are context around the change', () => {
    expect(
      editLines(
        '## Copy\n\nKeep copy short.\n## Next\n',
        '## Copy\n\nKeep copy short.\nCheck every locale.\n## Next\n'
      )
    ).toEqual([
      context('## Copy'),
      context(''),
      context('Keep copy short.'),
      added('Check every locale.'),
      context('## Next')
    ]);
  });

  test('a changed line shows as removed, then added, between the context', () => {
    expect(
      editLines('# Agents\nKeep copy short.\nThe end.', '# Agents\nKeep it short.\nThe end.')
    ).toEqual([
      context('# Agents'),
      removed('Keep copy short.'),
      added('Keep it short.'),
      context('The end.')
    ]);
  });

  test('a line that is only removed shows as removed, and an unchanged edit is all context', () => {
    expect(editLines('one\ntwo\nthree', 'one\nthree')).toEqual([
      context('one'),
      removed('two'),
      context('three')
    ]);
    expect(editLines('one\ntwo', 'one\ntwo')).toEqual([context('one'), context('two')]);
  });

  test('a line shared at both ends is shown once, never twice', () => {
    expect(editLines('same\nsame', 'same')).toEqual([context('same'), removed('same')]);
    expect(editLines('same', 'same\nsame')).toEqual([context('same'), added('same')]);
  });

  test('empty text has no lines, and a final newline adds no empty line', () => {
    expect(editLines('', '')).toEqual([]);
    expect(editLines(null, '')).toEqual([]);
    expect(editLines('gone\n', '')).toEqual([removed('gone')]);
    expect(editLines('line', 'line\n')).toEqual([context('line')]);
    // A blank line before the final newline is a line of its own.
    expect(editLines('line\n', 'line\n\n')).toEqual([context('line'), added('')]);
  });
});

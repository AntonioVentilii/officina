import { describe, expect, test } from 'bun:test';
import { tableProblems } from '../markdown-tables';

const check = (...lines: string[]) => tableProblems('doc.md', lines);

describe('tableProblems', () => {
  test('a table whose rows match its header passes', () => {
    expect(check('| A | B |', '| --- | :-: |', '| a | b |')).toEqual([]);
  });

  test('a row with an extra cell is reported with its line', () => {
    expect(check('| A | B |', '| --- | --- |', '| a | b | c |')).toEqual([
      'doc.md:3: table row has 3 cells, header 2'
    ]);
  });

  test('an escaped pipe stays inside its cell, an escaped backslash before a pipe does not', () => {
    expect(check('| A | B |', '| --- | --- |', '| a \\| b | c |')).toEqual([]);
    expect(check('| A | B |', '| --- | --- |', '| a \\\\| b | c |')).toEqual([
      'doc.md:3: table row has 3 cells, header 2'
    ]);
  });

  test('a table without outer pipes is checked too', () => {
    expect(check('A | B', '---|---', 'a | b')).toEqual([]);
    expect(check('A | B', '---|---', 'a | b | c')).toEqual([
      'doc.md:3: table row has 3 cells, header 2'
    ]);
  });

  test('pipes with no delimiter row under them are not a table', () => {
    expect(check('| a | b |', '| a |')).toEqual([]);
  });

  test('a fence closes only on the same marker, at least as long as the one that opened it', () => {
    const table = ['| A | B |', '| --- | --- |', '| a | b | c |'];
    expect(check('````md', '```', ...table, '````')).toEqual([]);
    expect(check('```md', '~~~', ...table, '```')).toEqual([]);
    expect(check('~~~', ...table, '~~~~')).toEqual([]);
    expect(check('```', '```', ...table)).toEqual(['doc.md:5: table row has 3 cells, header 2']);
  });
});

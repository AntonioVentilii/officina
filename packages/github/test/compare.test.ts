import { describe, expect, test } from 'bun:test';
import { COMPARE_FILE_LIMIT, changeFingerprint } from '../src';

describe('what a head changes against the base', () => {
  const files = [
    { filename: 'src/a.ts', status: 'modified', sha: 'blob-a' },
    { filename: 'src/b.ts', status: 'added', sha: 'blob-b' },
    { filename: 'src/old.ts', status: 'removed', sha: null }
  ];

  test('the same files with the same content give the same fingerprint, in any order', () => {
    expect(changeFingerprint([...files].reverse())).toBe(changeFingerprint(files));
  });

  test('a file with other content, or one more file, gives another', () => {
    const fingerprint = changeFingerprint(files);
    expect(changeFingerprint([{ ...files[0]!, sha: 'blob-a2' }, files[1]!, files[2]!])).not.toBe(
      fingerprint
    );
    expect(
      changeFingerprint([...files, { filename: 'src/c.ts', status: 'added', sha: 'blob-c' }])
    ).not.toBe(fingerprint);
  });

  test('paths with spaces never run into each other', () => {
    expect(
      changeFingerprint([
        { filename: 'b c', previous_filename: 'a', status: 'renamed', sha: 'blob' }
      ])
    ).not.toBe(
      changeFingerprint([
        { filename: 'c', previous_filename: 'a b', status: 'renamed', sha: 'blob' }
      ])
    );
  });

  test('a list GitHub may have cut says nothing', () => {
    expect(changeFingerprint(undefined)).toBeNull();
    const full = Array.from({ length: COMPARE_FILE_LIMIT }, (_, index) => ({
      filename: `f${index}.ts`,
      status: 'added',
      sha: `blob${index}`
    }));
    expect(changeFingerprint(full)).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import { describeUnlisted, unlistedFiles } from '../src';

const COMPONENTS = { pattern: 'src/lib/components/**', page: 'docs/ai/reusability.md' };
const UTILS = { pattern: 'src/lib/utils/*.ts', page: 'docs/ai/utils.md' };

describe('catalog check', () => {
  test('a new file under a catalog glob must come with its page', () => {
    const added = ['src/lib/components/Chip.svelte', 'src/lib/utils/date.ts', 'src/routes/a.ts'];
    expect(unlistedFiles([COMPONENTS, UTILS], added, added)).toEqual([
      { path: 'src/lib/components/Chip.svelte', catalog: COMPONENTS },
      { path: 'src/lib/utils/date.ts', catalog: UTILS }
    ]);
  });

  test('touching the page clears its catalog, and changed files that are not new never count', () => {
    const added = ['src/lib/components/Chip.svelte', 'src/lib/utils/date.ts'];
    expect(unlistedFiles([COMPONENTS, UTILS], added, [...added, 'docs/ai/reusability.md'])).toEqual(
      [{ path: 'src/lib/utils/date.ts', catalog: UTILS }]
    );
    expect(unlistedFiles([COMPONENTS], [], ['src/lib/components/Button.svelte'])).toEqual([]);
  });

  test('the finding names the file, the glob, the page and the rule', () => {
    const text = describeUnlisted([{ path: 'src/lib/utils/date.ts', catalog: UTILS }]);
    expect(text).toContain('`src/lib/utils/date.ts`');
    expect(text).toContain('`docs/ai/utils.md`');
    expect(text).toContain('rule 4');
  });
});

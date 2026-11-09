import { describe, expect, test } from 'bun:test';
import { catalogPagesToRead, describeUnlisted, unlistedFiles } from '../src';

const COMPONENTS = { pattern: 'src/lib/components/**', page: 'docs/ai/reusability.md' };
const UTILS = { pattern: 'src/lib/utils/*.ts', page: 'docs/ai/utils.md' };
const CHIP = 'src/lib/components/Chip.svelte';
const DATE = 'src/lib/utils/date.ts';

describe('catalog check', () => {
  test('only the pages whose glob a new file falls under are read', () => {
    expect(catalogPagesToRead([COMPONENTS, UTILS], [CHIP, 'src/routes/a.ts'])).toEqual([
      COMPONENTS.page
    ]);
    expect(catalogPagesToRead([COMPONENTS, UTILS], [])).toEqual([]);
  });

  test('a new file under a catalog glob must be named on its page as pushed', () => {
    const added = [CHIP, DATE, 'src/routes/a.ts'];
    expect(unlistedFiles([COMPONENTS, UTILS], added, {})).toEqual([
      { path: CHIP, catalog: COMPONENTS },
      { path: DATE, catalog: UTILS }
    ]);
    // A page with no such file, or an edit that says nothing about it, does not list it.
    expect(
      unlistedFiles([COMPONENTS, UTILS], added, {
        [COMPONENTS.page]: null,
        [UTILS.page]: '# Utils\n\n- `src/lib/utils/money.ts`: formats amounts\n'
      })
    ).toHaveLength(2);
  });

  test('the page names a file by its path or by its file name, as through an alias', () => {
    const pages = {
      [COMPONENTS.page]: '- `$lib/components/Chip.svelte`: a small label\n',
      [UTILS.page]: `- \`${DATE}\`: parses dates\n`
    };
    expect(unlistedFiles([COMPONENTS, UTILS], [CHIP, DATE], pages)).toEqual([]);
    // Files that change without being new never count.
    expect(unlistedFiles([COMPONENTS], [], {})).toEqual([]);
  });

  test('the finding names the file, the glob, the page and the rule', () => {
    const text = describeUnlisted([{ path: DATE, catalog: UTILS }]);
    expect(text).toContain(`\`${DATE}\``);
    expect(text).toContain('`docs/ai/utils.md`');
    expect(text).toContain('rule 4');
  });
});

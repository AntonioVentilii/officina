import { Glob } from 'bun';
import type { Catalog } from './config';

export interface UnlistedFile {
  readonly path: string;
  readonly catalog: Catalog;
}

/** The text of each catalog page at the pushed head, by path; `null` when the branch has no such page. */
export type CatalogPages = Readonly<Record<string, string | null>>;

const matches = (catalog: Catalog, path: string): boolean => new Glob(catalog.pattern).match(path);

/** The catalog pages a change must be read against: those whose glob some added file matches. */
export const catalogPagesToRead = (
  catalogs: readonly Catalog[],
  addedPaths: readonly string[]
): string[] => [
  ...new Set(
    catalogs
      .filter((catalog) => addedPaths.some((path) => matches(catalog, path)))
      .map((catalog) => catalog.page)
  )
];

/**
 * Whether a page names a file: by its path from the repository root, or by its file name, since
 * pages often write paths through an alias (`$lib/components/Chip.svelte`).
 */
export const pageLists = (text: string, path: string): boolean =>
  text.includes(path) || text.includes(path.slice(path.lastIndexOf('/') + 1));

/**
 * Files a change adds under a catalog's glob that the catalog's page, as pushed, does not name.
 * Read from the real diff and the real page like the lane, so neither the agent's account of what
 * it did nor an empty edit to the page decides it.
 */
export const unlistedFiles = (
  catalogs: readonly Catalog[],
  addedPaths: readonly string[],
  pages: CatalogPages
): UnlistedFile[] =>
  catalogs.flatMap((catalog) => {
    const text = pages[catalog.page] ?? '';
    return addedPaths
      .filter((path) => matches(catalog, path) && !pageLists(text, path))
      .map((path) => ({ path, catalog }));
  });

/** What the builder reads in its next round, one line per file. */
export const describeUnlisted = (files: readonly UnlistedFile[]): string =>
  files
    .map(
      ({ path, catalog }) =>
        `\`${path}\` is new under \`${catalog.pattern}\` but \`${catalog.page}\` does not name it: list it on that page by its path in this change, or reuse what the page already lists (code standard, rule 4).`
    )
    .join('\n');

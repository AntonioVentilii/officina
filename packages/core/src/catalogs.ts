import { Glob } from 'bun';
import type { Catalog } from './config';

export interface UnlistedFile {
  readonly path: string;
  readonly catalog: Catalog;
}

/**
 * Files a change adds under a catalog's glob while leaving that catalog's page untouched. Read from
 * the real diff like the lane, so the agent's own account of what it did never decides it.
 */
export const unlistedFiles = (
  catalogs: readonly Catalog[],
  addedPaths: readonly string[],
  changedPaths: readonly string[]
): UnlistedFile[] =>
  catalogs.flatMap((catalog) => {
    if (changedPaths.includes(catalog.page)) return [];
    const glob = new Glob(catalog.pattern);
    return addedPaths.filter((path) => glob.match(path)).map((path) => ({ path, catalog }));
  });

/** What the builder reads in its next round, one line per file. */
export const describeUnlisted = (files: readonly UnlistedFile[]): string =>
  files
    .map(
      ({ path, catalog }) =>
        `\`${path}\` is new under \`${catalog.pattern}\` but \`${catalog.page}\` does not list it: add it to that page in this change, or reuse what the page already lists (code standard, rule 4).`
    )
    .join('\n');

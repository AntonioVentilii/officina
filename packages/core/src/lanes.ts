import { Glob } from 'bun';

export const LANES = ['green', 'standard', 'red'] as const;
export type Lane = (typeof LANES)[number];

const STRICTNESS: Record<Lane, number> = { green: 0, standard: 1, red: 2 };

export const stricterLane = (a: Lane, b: Lane): Lane => (STRICTNESS[a] >= STRICTNESS[b] ? a : b);

export interface LaneMatcher {
  readonly red: readonly Glob[];
  readonly green: readonly Glob[];
}

export const compileLaneMatcher = (paths: {
  red: readonly string[];
  green: readonly string[];
}): LaneMatcher => ({
  red: paths.red.map((pattern) => new Glob(pattern)),
  green: paths.green.map((pattern) => new Glob(pattern))
});

const matchesAny = (globs: readonly Glob[], path: string): boolean =>
  globs.some((glob) => glob.match(path));

/**
 * Red if any path is red. Green only if there is at least one path and every path is green,
 * so an empty or unknown change never lands in the least guarded lane. Everything else is standard.
 */
export const computeLane = (changedPaths: readonly string[], matcher: LaneMatcher): Lane => {
  if (changedPaths.some((path) => matchesAny(matcher.red, path))) {
    return 'red';
  }
  if (changedPaths.length > 0 && changedPaths.every((path) => matchesAny(matcher.green, path))) {
    return 'green';
  }
  return 'standard';
};

export const redPaths = (changedPaths: readonly string[], matcher: LaneMatcher): string[] =>
  changedPaths.filter((path) => matchesAny(matcher.red, path));

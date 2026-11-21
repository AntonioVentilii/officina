import { Glob } from 'bun';
import type { Guard, Lane } from '@officina/core';
import {
  AGENT_EFFORTS,
  MODEL_TIERS,
  ROLE_MODELS,
  type AgentEffort,
  type ModelChoice,
  type ModelTier,
  type RunnerRole
} from '@officina/runner';

/** What Officina knows about a step before it starts, from which its model is chosen. */
export interface StepSignals {
  readonly role: RunnerRole;
  readonly lane: Lane | null;
  readonly guards: readonly Guard[];
  /** The paths the change touches: the latest push's, with what the spec predicts. */
  readonly paths: readonly string[];
  /** The lines the latest push changed; `null` before the first push. */
  readonly diffLines: number | null;
  /** The project's `models.strong_paths`. */
  readonly strongPaths: readonly string[];
  /** Times the work went back to building (the task's `fixRounds`). */
  readonly fixRounds: number;
  /** Earlier runs of this role on the task that left no usable result. */
  readonly failedAttempts: number;
}

/** A step's model, with why in a few words for its run's record. */
export interface StepModel extends ModelChoice {
  readonly reason: string;
}

/** Where a change stops being small, or starts being large. */
export const CHANGE_SIZES = {
  /** At most this many lines over at most `smallPaths` files, or only Markdown: a quick read. */
  smallLines: 150,
  smallPaths: 5,
  /** Past either, a change is large. */
  largeLines: 500,
  largePaths: 20,
  /** A change over this many areas of the repository (`areaOf`) is cross-package. */
  crossAreas: 3
} as const;

/** A build sent back this many times counts as rejected, as a failed attempt does. */
export const REJECTED_ROUNDS = 2;

/** The roles whose work grows with the change; the others only talk, plan or look back. */
const CHANGE_ROLES: ReadonlySet<RunnerRole> = new Set([
  'spec',
  'builder',
  'onboarder',
  'reviewer_spec',
  'reviewer_correctness'
]);

/** The weakest tier a role may run on, whatever the change: a correctness review needs judgment. */
const TIER_FLOORS: Readonly<Partial<Record<RunnerRole, ModelTier>>> = {
  reviewer_correctness: 'sonnet'
};

/** What a risky change runs on. */
const STRONGEST: ModelChoice = { tier: 'opus', effort: 'high' };
/** What a small spec review runs on. */
const QUICK: ModelChoice = { tier: 'haiku', effort: 'low' };

const isDoc = (path: string) => /\.mdx?$/i.test(path);

/** A path's area: its first two folders (`packages/core`), or its only one, or `.` at the root. */
export const areaOf = (path: string): string => {
  const folders = path.split('/').slice(0, -1);
  return folders.slice(0, 2).join('/') || '.';
};

const rank = <T>(order: readonly T[], value: T) => order.indexOf(value);
const atLeast = (effort: AgentEffort, floor: AgentEffort): AgentEffort =>
  rank(AGENT_EFFORTS, effort) >= rank(AGENT_EFFORTS, floor) ? effort : floor;

/** Why a change needs the strongest model, or `null` when nothing says so. */
const riskOf = (signals: StepSignals): string | null => {
  if (signals.lane === 'red') return 'red lane';
  if (signals.guards.length > 0) return `guarded (${signals.guards.join(', ')})`;
  const strong = signals.strongPaths.map((pattern) => new Glob(pattern));
  if (signals.paths.some((path) => strong.some((glob) => glob.match(path)))) return 'strong path';
  // However long, a change to docs alone is no harder to get right.
  const code = signals.paths.filter((path) => !isDoc(path));
  if (signals.paths.length > 0 && code.length === 0) return null;
  if ((signals.diffLines ?? 0) > CHANGE_SIZES.largeLines || code.length > CHANGE_SIZES.largePaths)
    return 'large change';
  if (new Set(code.map(areaOf)).size >= CHANGE_SIZES.crossAreas) return 'cross-package change';
  return null;
};

const isSmall = ({ paths, diffLines }: StepSignals): boolean =>
  paths.length > 0 &&
  (paths.every(isDoc) ||
    (diffLines !== null &&
      diffLines <= CHANGE_SIZES.smallLines &&
      paths.length <= CHANGE_SIZES.smallPaths));

/** The model before any evidence from earlier runs. */
const upFront = (signals: StepSignals): StepModel => {
  if (CHANGE_ROLES.has(signals.role)) {
    const risk = riskOf(signals);
    if (risk) return { ...STRONGEST, reason: risk };
    if (signals.role === 'reviewer_spec' && isSmall(signals))
      return { ...QUICK, reason: 'small change' };
  }
  return { ...ROLE_MODELS[signals.role], reason: 'role default' };
};

/** Why the role should run one tier up, or `null` when nothing went wrong before. */
const evidenceOf = (signals: StepSignals): string | null => {
  if (signals.failedAttempts > 0) return 'after a failed attempt';
  if (signals.role === 'builder' && signals.fixRounds >= REJECTED_ROUNDS)
    return `after ${signals.fixRounds} rounds sent back`;
  return null;
};

/** One tier up, thinking at least as hard as that tier's work asks; past the top, harder. */
const escalate = (choice: StepModel, why: string): StepModel => {
  const next = MODEL_TIERS[rank(MODEL_TIERS, choice.tier) + 1];
  return next
    ? { tier: next, effort: atLeast(choice.effort, 'medium'), reason: `${choice.reason}, ${why}` }
    : {
        tier: choice.tier,
        effort: atLeast(choice.effort, 'high'),
        reason: `${choice.reason}, ${why}`
      };
};

const withFloor = (role: RunnerRole, choice: StepModel): StepModel => {
  const floor = TIER_FLOORS[role];
  if (!floor || rank(MODEL_TIERS, choice.tier) >= rank(MODEL_TIERS, floor)) return choice;
  return { tier: floor, effort: atLeast(choice.effort, 'medium'), reason: choice.reason };
};

/**
 * The model and effort a step runs at, by rule: the role's own (`ROLE_MODELS`), the strongest for a
 * risky change (red lane, a guard, a strong path, a large or cross-package change), the cheapest
 * for the spec review of a small one, and one tier up, once, after a failed or rejected attempt.
 */
export const chooseModel = (signals: StepSignals): StepModel => {
  const chosen = upFront(signals);
  const evidence = evidenceOf(signals);
  return withFloor(signals.role, evidence ? escalate(chosen, evidence) : chosen);
};

import { z } from 'zod';
import { compileLaneMatcher, type Lane, type LaneMatcher } from './lanes';

const requirementSchema = z.union([
  z.strictObject({ role: z.enum(['maintainer', 'owner']) }),
  z.strictObject({ domain: z.string().min(1), when: z.literal('user_visible').optional() }),
  z.strictObject({ requester: z.literal(true) })
]);

const policySchema = z.array(requirementSchema);

const laneSchema = z.strictObject({
  /** Ignored for `standard`, which is whatever is neither red nor green. */
  paths: z.array(z.string().min(1)).optional(),
  agents_build: z.boolean().optional(),
  wip: z.number().int().positive().optional(),
  diff_lines: z.number().int().positive().optional(),
  budget_usd: z.number().positive().optional(),
  fix_rounds: z.number().int().nonnegative().optional(),
  approvals: z
    .strictObject({ spec_review: policySchema.optional(), verifying: policySchema.optional() })
    .optional()
});

const projectConfigSchema = z.strictObject({
  version: z.literal(1),
  docs: z.strictObject({
    entry: z.string().min(1),
    spec_template: z.string().min(1).optional(),
    spec_dir: z.string().min(1).optional(),
    pr_template: z.string().min(1).optional()
  }),
  setup: z.array(z.string().min(1)).optional(),
  verify: z.array(z.string().min(1)).optional(),
  runtime: z
    .strictObject({
      /** Extra hosts agent sandboxes may reach beyond package registries, e.g. a private registry. */
      allowed_hosts: z.array(z.string().min(1)).optional()
    })
    .optional(),
  lanes: z
    .strictObject({
      red: laneSchema.optional(),
      standard: laneSchema.optional(),
      green: laneSchema.optional()
    })
    .optional()
});

export type Requirement = z.infer<typeof requirementSchema>;
export type Policy = readonly Requirement[];
export type Gate = 'spec_review' | 'verifying';

export interface LaneSettings {
  readonly agentsBuild: boolean;
  readonly wip: number;
  readonly diffLines: number;
  readonly budgetUsd: number;
  readonly fixRounds: number;
  readonly approvals: Readonly<Record<Gate, Policy>>;
}

export interface ProjectConfig {
  readonly docs: {
    readonly entry: string;
    readonly specTemplate: string | null;
    readonly specDir: string | null;
    readonly prTemplate: string | null;
  };
  readonly setup: readonly string[];
  readonly verify: readonly string[];
  readonly runtime: { readonly allowedHosts: readonly string[] };
  readonly lanes: Readonly<Record<Lane, LaneSettings>>;
  readonly laneMatcher: LaneMatcher;
}

const DEFAULT_POLICY: Policy = [{ role: 'maintainer' }];

const LANE_DEFAULTS: Record<Lane, Omit<LaneSettings, 'approvals'>> = {
  green: { agentsBuild: true, wip: 5, diffLines: 600, budgetUsd: 5, fixRounds: 2 },
  standard: { agentsBuild: true, wip: 3, diffLines: 800, budgetUsd: 25, fixRounds: 2 },
  red: { agentsBuild: false, wip: 1, diffLines: 800, budgetUsd: 25, fixRounds: 2 }
};

type RawLane = z.infer<typeof laneSchema>;

const normalizeLane = (lane: Lane, raw: RawLane | undefined): LaneSettings => {
  const defaults = LANE_DEFAULTS[lane];
  return {
    // Red is the lane where agents never build; config cannot switch that off.
    agentsBuild: lane === 'red' ? false : (raw?.agents_build ?? defaults.agentsBuild),
    wip: raw?.wip ?? defaults.wip,
    diffLines: raw?.diff_lines ?? defaults.diffLines,
    budgetUsd: raw?.budget_usd ?? defaults.budgetUsd,
    fixRounds: raw?.fix_rounds ?? defaults.fixRounds,
    approvals: {
      spec_review: raw?.approvals?.spec_review ?? DEFAULT_POLICY,
      verifying: raw?.approvals?.verifying ?? DEFAULT_POLICY
    }
  };
};

export type ConfigResult =
  | { readonly ok: true; readonly config: ProjectConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

export const parseProjectConfig = (input: unknown): ConfigResult => {
  const parsed = projectConfigSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
      )
    };
  }
  const raw = parsed.data;
  const redGlobs = raw.lanes?.red?.paths ?? [];
  const greenGlobs = raw.lanes?.green?.paths ?? [];
  return {
    ok: true,
    config: {
      docs: {
        entry: raw.docs.entry,
        specTemplate: raw.docs.spec_template ?? null,
        specDir: raw.docs.spec_dir ?? null,
        prTemplate: raw.docs.pr_template ?? null
      },
      setup: raw.setup ?? [],
      verify: raw.verify ?? [],
      runtime: { allowedHosts: raw.runtime?.allowed_hosts ?? [] },
      lanes: {
        green: normalizeLane('green', raw.lanes?.green),
        standard: normalizeLane('standard', raw.lanes?.standard),
        red: normalizeLane('red', raw.lanes?.red)
      },
      laneMatcher: compileLaneMatcher({ red: redGlobs, green: greenGlobs })
    }
  };
};

export const parseProjectConfigYaml = (yaml: string): ConfigResult => {
  let document: unknown;
  try {
    document = Bun.YAML.parse(yaml);
  } catch (error) {
    return { ok: false, errors: [`yaml: ${(error as Error).message}`] };
  }
  return parseProjectConfig(document);
};

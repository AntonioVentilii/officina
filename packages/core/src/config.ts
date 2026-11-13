import { z } from 'zod';
import { compileLaneMatcher, type Lane, type LaneMatcher } from './lanes';

/** The board's two looks. A member's own pick wins over the project's default. */
export const BOARD_LOOKS = ['modernista', 'tecnica'] as const;

/** The look a project's board has when its config names none. */
export const DEFAULT_BOARD_LOOK: (typeof BOARD_LOOKS)[number] = 'modernista';
export type BoardLook = (typeof BOARD_LOOKS)[number];

/** Where a project keeps the agent docs the code standard asks for, unless its config says otherwise. */
export const DEFAULT_STANDARDS_DIR = 'docs/ai';

/**
 * The pages the agent docs folder holds unless a project lists its own: an index, the governance
 * and meta-update map, the folder taxonomy, the patterns in use, the catalog of shared code, how
 * tests are written, and the pull request conventions.
 */
export const DEFAULT_STANDARDS_PAGES = [
  'README.md',
  'governance.md',
  'structure.md',
  'patterns.md',
  'reusability.md',
  'testing.md',
  'pr-and-ci.md'
] as const;

/** A path inside the repository: relative, without `..`, so it cannot point outside it. */
const repoPath = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith('/') && !path.split('/').includes('..'),
    'must be a relative path inside the repository'
  );

const markdownPage = repoPath.refine((path) => path.endsWith('.md'), 'must be a Markdown page');

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
  /** Green only: a result skips a person's check when nothing about it calls for one. */
  auto_verify: z.boolean().optional(),
  approvals: z
    .strictObject({ spec_review: policySchema.optional(), verifying: policySchema.optional() })
    .optional()
});

const projectConfigSchema = z
  .strictObject({
    version: z.literal(1),
    docs: z.strictObject({
      /** What every agent reads first. A path from the repository root, like every other doc. */
      entry: markdownPage,
      spec_template: z.string().min(1).optional(),
      spec_dir: z.string().min(1).optional(),
      pr_template: z.string().min(1).optional(),
      /** The folder of agent docs every project must hold; `docs/ai` unless set. */
      standards: repoPath.optional(),
      /** The pages that folder must hold, relative to it. Left out, the default set. */
      pages: z.array(markdownPage).min(1).optional(),
      /**
       * Path glob of new files to the catalog page, relative to the docs folder, that must list them:
       * a file added under the glob without the page changing is a finding the builder must address.
       */
      catalogs: z.record(z.string().min(1), markdownPage).optional()
    }),
    setup: z.array(z.string().min(1)).optional(),
    intake: z
      .strictObject({
        /** An agent asks the requester follow-up questions before triage. On unless turned off. */
        interview: z.boolean().optional()
      })
      .optional(),
    verify: z.array(z.string().min(1)).optional(),
    release: z
      .strictObject({
        /** What merging into the default branch deploys. Left out, it is taken to be production. */
        on_merge: z.enum(['production', 'staging', 'nothing']).optional()
      })
      .optional(),
    pull_request: z
      .strictObject({
        /** Regular expression every pull request title must match, e.g. the repo's commit convention. */
        title_pattern: z
          .string()
          .min(1)
          .refine((pattern) => {
            try {
              new RegExp(pattern);
              return true;
            } catch {
              return false;
            }
          }, 'must be a valid regular expression')
          .optional(),
        /**
         * Once a result is verified (or auto-verified), turn on GitHub's auto-merge so the branch
         * rules decide when it lands. Left out, it is off and a person merges on GitHub.
         */
        auto_merge: z.boolean().optional(),
        /**
         * Once Officina opens a pull request, ask Copilot to review it as the member who requested
         * the task, with their own GitHub account: the GitHub App has no Copilot seat, so a branch
         * rule that asks for Copilot's review does not start it on the App's pull requests. Left
         * out, it is off.
         */
        copilot_review: z.boolean().optional()
      })
      .optional(),
    runtime: z
      .strictObject({
        /** Extra hosts agent sandboxes may reach beyond package registries, e.g. a private registry. */
        allowed_hosts: z.array(z.string().min(1)).optional()
      })
      .optional(),
    board: z
      .strictObject({
        /** The look members see until they pick their own. Left out, it is modernista. */
        look: z.enum(BOARD_LOOKS).optional()
      })
      .optional(),
    lanes: z
      .strictObject({
        red: laneSchema.optional(),
        standard: laneSchema.optional(),
        green: laneSchema.optional()
      })
      .optional()
  })
  .refine((raw) => !raw.lanes?.red?.auto_verify && !raw.lanes?.standard?.auto_verify, {
    message: 'auto_verify is only allowed in the green lane',
    path: ['lanes']
  });

export type Requirement = z.infer<typeof requirementSchema>;
export type Policy = readonly Requirement[];
/** The stages where people approve: the spec, then the result. */
export const GATES = ['spec_review', 'verifying'] as const;
export type Gate = (typeof GATES)[number];
export const isGate = (stage: string): stage is Gate =>
  (GATES as readonly string[]).includes(stage);
export type ReleaseOnMerge = 'production' | 'staging' | 'nothing';

export interface LaneSettings {
  /** The globs that put a change in this lane; always empty for `standard`. */
  readonly paths: readonly string[];
  readonly agentsBuild: boolean;
  readonly wip: number;
  readonly diffLines: number;
  readonly budgetUsd: number;
  readonly fixRounds: number;
  readonly autoVerify: boolean;
  readonly approvals: Readonly<Record<Gate, Policy>>;
}

/** New files under `pattern` must be listed on `page`, a path from the repository root. */
export interface Catalog {
  readonly pattern: string;
  readonly page: string;
}

export interface StandardsDocs {
  readonly dir: string;
  /** Every page the folder must hold, as paths from the repository root. */
  readonly pages: readonly string[];
  readonly catalogs: readonly Catalog[];
}

export interface ProjectConfig {
  readonly docs: {
    readonly entry: string;
    readonly specTemplate: string | null;
    readonly specDir: string | null;
    readonly prTemplate: string | null;
    readonly standards: StandardsDocs;
  };
  readonly setup: readonly string[];
  readonly intake: { readonly interview: boolean };
  readonly verify: readonly string[];
  readonly release: { readonly onMerge: ReleaseOnMerge };
  readonly runtime: { readonly allowedHosts: readonly string[] };
  readonly pullRequest: {
    readonly titlePattern: string | null;
    readonly autoMerge: boolean;
    readonly copilotReview: boolean;
  };
  readonly board: { readonly look: BoardLook };
  readonly lanes: Readonly<Record<Lane, LaneSettings>>;
  readonly laneMatcher: LaneMatcher;
}

const DEFAULT_POLICY: Policy = [{ role: 'maintainer' }];

const LANE_DEFAULTS: Record<Lane, Omit<LaneSettings, 'paths' | 'approvals'>> = {
  green: {
    agentsBuild: true,
    wip: 5,
    diffLines: 600,
    budgetUsd: 5,
    fixRounds: 2,
    autoVerify: false
  },
  standard: {
    agentsBuild: true,
    wip: 3,
    diffLines: 800,
    budgetUsd: 25,
    fixRounds: 2,
    autoVerify: false
  },
  red: {
    agentsBuild: false,
    wip: 1,
    diffLines: 800,
    budgetUsd: 25,
    fixRounds: 2,
    autoVerify: false
  }
};

type RawLane = z.infer<typeof laneSchema>;

const normalizeLane = (lane: Lane, raw: RawLane | undefined): LaneSettings => {
  const defaults = LANE_DEFAULTS[lane];
  return {
    paths: lane === 'standard' ? [] : (raw?.paths ?? []),
    // Red is the lane where agents never build; config cannot switch that off.
    agentsBuild: lane === 'red' ? false : (raw?.agents_build ?? defaults.agentsBuild),
    wip: raw?.wip ?? defaults.wip,
    diffLines: raw?.diff_lines ?? defaults.diffLines,
    budgetUsd: raw?.budget_usd ?? defaults.budgetUsd,
    fixRounds: raw?.fix_rounds ?? defaults.fixRounds,
    autoVerify: lane === 'green' && (raw?.auto_verify ?? defaults.autoVerify),
    approvals: {
      spec_review: raw?.approvals?.spec_review ?? DEFAULT_POLICY,
      verifying: raw?.approvals?.verifying ?? DEFAULT_POLICY
    }
  };
};

type RawDocs = z.infer<typeof projectConfigSchema>['docs'];

const normalizeStandards = (raw: RawDocs): StandardsDocs => {
  const dir = (raw.standards ?? DEFAULT_STANDARDS_DIR).replace(/\/+$/, '');
  const inDir = (page: string) => `${dir}/${page}`;
  return {
    dir,
    pages: (raw.pages ?? DEFAULT_STANDARDS_PAGES).map(inDir),
    catalogs: Object.entries(raw.catalogs ?? {}).map(([pattern, page]) => ({
      pattern,
      page: inDir(page)
    }))
  };
};

/** Tool layers the onboarder turns into thin pointers to the entry document. */
export const TOOL_LAYER_DOCS = ['CLAUDE.md'] as const;

/** Whether a path is a page agents learn from: the entry document or a file in the docs folder. */
export const isStandardsPage = (config: Pick<ProjectConfig, 'docs'>, path: string): boolean =>
  path === config.docs.entry || path.startsWith(`${config.docs.standards.dir}/`);

/** Whether a path is part of the agent docs: the entry document, a tool layer or the docs folder. */
export const isAgentDocsPath = (config: Pick<ProjectConfig, 'docs'>, path: string): boolean =>
  isStandardsPage(config, path) || (TOOL_LAYER_DOCS as readonly string[]).includes(path);

/**
 * Every file a project must hold before agents build in it: the entry document, the agent docs
 * pages and every catalog page, each once.
 */
export const requiredDocs = (config: Pick<ProjectConfig, 'docs'>): string[] => [
  ...new Set([
    config.docs.entry,
    ...config.docs.standards.pages,
    ...config.docs.standards.catalogs.map((catalog) => catalog.page)
  ])
];

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
  const lanes = {
    green: normalizeLane('green', raw.lanes?.green),
    standard: normalizeLane('standard', raw.lanes?.standard),
    red: normalizeLane('red', raw.lanes?.red)
  };
  return {
    ok: true,
    config: {
      docs: {
        entry: raw.docs.entry,
        specTemplate: raw.docs.spec_template ?? null,
        specDir: raw.docs.spec_dir ?? null,
        prTemplate: raw.docs.pr_template ?? null,
        standards: normalizeStandards(raw.docs)
      },
      setup: raw.setup ?? [],
      intake: { interview: raw.intake?.interview ?? true },
      verify: raw.verify ?? [],
      release: { onMerge: raw.release?.on_merge ?? 'production' },
      runtime: { allowedHosts: raw.runtime?.allowed_hosts ?? [] },
      pullRequest: {
        titlePattern: raw.pull_request?.title_pattern ?? null,
        autoMerge: raw.pull_request?.auto_merge ?? false,
        copilotReview: raw.pull_request?.copilot_review ?? false
      },
      board: { look: raw.board?.look ?? DEFAULT_BOARD_LOOK },
      lanes,
      laneMatcher: compileLaneMatcher({ red: lanes.red.paths, green: lanes.green.paths })
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

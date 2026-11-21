import { createHash } from 'node:crypto';
import {
  AGENT_ROLES,
  OUTPUT_SCHEMAS,
  isBuildRole,
  type AgentRole,
  type ModelTier
} from '@officina/core';
import type { AgentCreateParams } from '@anthropic-ai/sdk/resources/beta/agents/agents';
import { z } from 'zod';
import { PINNED_MODELS, type TierModels } from './models';
import { READER_NAME, READER_PROMPT, withReader } from './reader';
import { loadPrompt, loadStandard, withStandard } from './standard';

export type AgentTools = NonNullable<AgentCreateParams['tools']>;
type AgentToolConfig = NonNullable<
  Extract<AgentTools[number], { type: 'agent_toolset_20260401' }>['configs']
>[number];

/** The single custom tool every role uses to hand its result back to the engine. */
export const RESULT_TOOL = 'submit_result';

/** Every agent role runs on the runner; the list lives in core with the lifecycle. */
export const RUNNER_ROLES = AGENT_ROLES;
export type RunnerRole = AgentRole;

/** Whether a role named outside the type system (a step due, a prompt's file name) runs here. */
export const isRunnerRole = (role: string): role is RunnerRole =>
  (RUNNER_ROLES as readonly string[]).includes(role);

const WRITE_TOOLS_OFF: AgentToolConfig[] = [
  { name: 'write', type: 'write', enabled: false },
  { name: 'edit', type: 'edit', enabled: false }
];

/** The effort levels from the least thinking to the most. */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export interface AgentModel {
  readonly id: string;
  readonly effort: AgentEffort;
}

/** A model by its tier, before the tier is resolved to an id. */
export interface ModelChoice {
  readonly tier: ModelTier;
  readonly effort: AgentEffort;
}

/**
 * What each role runs on when nothing about the task says otherwise: the agent's own model, and
 * where the engine's choice for a step starts (`chooseModel` in the engine). Effort is set
 * explicitly because the default moves between releases (Opus 5.5 dropped it to medium).
 */
export const ROLE_MODELS: Readonly<Record<RunnerRole, ModelChoice>> = {
  interviewer: { tier: 'haiku', effort: 'low' },
  spec: { tier: 'sonnet', effort: 'medium' },
  builder: { tier: 'sonnet', effort: 'medium' },
  reviewer_spec: { tier: 'sonnet', effort: 'medium' },
  reviewer_correctness: { tier: 'sonnet', effort: 'medium' },
  chooser: { tier: 'haiku', effort: 'low' },
  learner: { tier: 'haiku', effort: 'low' },
  onboarder: { tier: 'sonnet', effort: 'medium' }
};

/** A choice with its tier resolved to the id `models` names for it. */
export const modelFor = (choice: ModelChoice, models: TierModels): AgentModel => ({
  id: models[choice.tier],
  effort: choice.effort
});

/** What every agent the runner syncs is made of. */
export interface AgentShape {
  readonly name: string;
  readonly model: AgentModel;
  readonly system: string;
  readonly tools: AgentTools;
  /** Changes whenever anything that shapes the agent changes; a new hash means a new agent version. */
  readonly hash: string;
}

export interface AgentDefinition extends AgentShape {
  readonly role: RunnerRole;
  /** The reading worker this role hands exploration to, or `null` when it reads everything itself. */
  readonly reader: AgentShape | null;
}

/** Thinks least: it locates and quotes, and every judgment stays with the role that asked. */
export const READER_EFFORT: AgentEffort = 'low';

/**
 * The roles whose sessions read the most, each given the reader: a build explores the code it
 * changes, a correctness review the diff's surroundings and the project's agent docs.
 */
export const READER_ROLES = [
  'builder',
  'reviewer_correctness'
] as const satisfies readonly RunnerRole[];

export const hasReader = (role: RunnerRole): boolean =>
  (READER_ROLES as readonly RunnerRole[]).includes(role);

const hashOf = (parts: Record<string, unknown>): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/**
 * The reading worker: read, glob and grep only, so it can neither change the workspace nor push with
 * the session's token, and no result tool, so only the role that asked hands a result in.
 */
export const buildReaderDefinition = (
  system: string,
  modelId: string = PINNED_MODELS.haiku
): AgentShape => {
  const tools: AgentTools = [
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: false, permission_policy: { type: 'always_allow' } },
      configs: [
        { name: 'read', type: 'read', enabled: true },
        { name: 'glob', type: 'glob', enabled: true },
        { name: 'grep', type: 'grep', enabled: true }
      ]
    }
  ];
  const model: AgentModel = { id: modelId, effort: READER_EFFORT };
  return {
    name: READER_NAME,
    model,
    system,
    tools,
    hash: hashOf({ name: READER_NAME, model, system, tools })
  };
};

/** The custom tool's input schema: the role's output contract wrapped in `{ result }`. */
export const resultToolInputSchema = (role: RunnerRole) => {
  const { $schema: _ignored, ...contract } = z.toJSONSchema(OUTPUT_SCHEMAS[role], { io: 'input' });
  return {
    type: 'object' as const,
    properties: { result: contract },
    required: ['result']
  };
};

/**
 * A role's agent. With a reader, the reader's hash is part of the role's, so a changed reader
 * becomes a new version of every role that hands it work, pinned to the reader's new version.
 */
export const buildDefinition = (
  role: RunnerRole,
  system: string,
  models: TierModels = PINNED_MODELS,
  reader: AgentShape | null = null
): AgentDefinition => {
  const disabled: AgentToolConfig[] = [
    // Web access is off for every role: task text is untrusted, and nothing here needs the web.
    { name: 'web_search', type: 'web_search', enabled: false },
    { name: 'web_fetch', type: 'web_fetch', enabled: false },
    // Only the build roles change files; the engine holds each to its own task branch.
    ...(isBuildRole(role) ? [] : WRITE_TOOLS_OFF)
  ];
  const tools: AgentTools = [
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
      configs: disabled
    },
    {
      type: 'custom',
      name: RESULT_TOOL,
      description:
        'Submit your final result. Call it once when you are done. If it is rejected, fix every listed problem and call it again.',
      input_schema: resultToolInputSchema(role)
    }
  ];
  const name = `officina-${role.replaceAll('_', '-')}`;
  const model = modelFor(ROLE_MODELS[role], models);
  const hash = hashOf(
    reader ? { name, model, system, tools, reader: reader.hash } : { name, model, system, tools }
  );
  return { role, name, model, system, tools, reader, hash };
};

/**
 * Reads `agents/<role>.md` prompts from a directory and builds every runner role's definition, each
 * on its own tier of `models` and its prompt followed by the code standard. The roles in
 * `READER_ROLES` also get the reader, built from `agents/reader.md` on the Haiku tier, and the
 * rules for handing it work before the standard.
 */
export const loadDefinitions = async (
  promptsDir: string,
  models: TierModels = PINNED_MODELS
): Promise<AgentDefinition[]> => {
  const standard = await loadStandard();
  const reader = buildReaderDefinition(await loadPrompt(promptsDir, READER_PROMPT), models.haiku);
  return Promise.all(
    RUNNER_ROLES.map(async (role) => {
      const prompt = await loadPrompt(promptsDir, role);
      return hasReader(role)
        ? buildDefinition(role, withStandard(withReader(prompt), standard), models, reader)
        : buildDefinition(role, withStandard(prompt, standard), models);
    })
  );
};

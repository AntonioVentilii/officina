import { createHash } from 'node:crypto';
import { AGENT_ROLES, OUTPUT_SCHEMAS, isBuildRole, type AgentRole } from '@officina/core';
import type { AgentCreateParams } from '@anthropic-ai/sdk/resources/beta/agents/agents';
import { z } from 'zod';
import { PINNED_MODELS, type ModelTier, type TierModels } from './models';
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

export interface AgentDefinition {
  readonly role: RunnerRole;
  readonly name: string;
  readonly model: AgentModel;
  readonly system: string;
  readonly tools: AgentTools;
  /** Changes whenever anything that shapes the agent changes; a new hash means a new agent version. */
  readonly hash: string;
}

/** The custom tool's input schema: the role's output contract wrapped in `{ result }`. */
export const resultToolInputSchema = (role: RunnerRole) => {
  const { $schema: _ignored, ...contract } = z.toJSONSchema(OUTPUT_SCHEMAS[role], { io: 'input' });
  return {
    type: 'object' as const,
    properties: { result: contract },
    required: ['result']
  };
};

export const buildDefinition = (
  role: RunnerRole,
  system: string,
  models: TierModels = PINNED_MODELS
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
  const hash = createHash('sha256')
    .update(JSON.stringify({ name, model, system, tools }))
    .digest('hex');
  return { role, name, model, system, tools, hash };
};

/**
 * Reads `agents/<role>.md` prompts from a directory and builds every runner role's definition, each
 * prompt followed by the code standard.
 */
export const loadDefinitions = async (
  promptsDir: string,
  models: TierModels = PINNED_MODELS
): Promise<AgentDefinition[]> => {
  const standard = await loadStandard();
  return Promise.all(
    RUNNER_ROLES.map(async (role) =>
      buildDefinition(role, withStandard(await loadPrompt(promptsDir, role), standard), models)
    )
  );
};

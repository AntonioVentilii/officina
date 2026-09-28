import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { OUTPUT_SCHEMAS } from '@officina/core';
import type { AgentCreateParams } from '@anthropic-ai/sdk/resources/beta/agents/agents';
import { z } from 'zod';

export type AgentTools = NonNullable<AgentCreateParams['tools']>;
type AgentToolConfig = NonNullable<
  Extract<AgentTools[number], { type: 'agent_toolset_20260401' }>['configs']
>[number];

/** The single custom tool every role uses to hand its result back to the engine. */
export const RESULT_TOOL = 'submit_result';

export const RUNNER_ROLES = [
  'interviewer',
  'spec',
  'builder',
  'reviewer_spec',
  'reviewer_correctness',
  'chooser',
  'learner'
] as const;
export type RunnerRole = (typeof RUNNER_ROLES)[number];

/** Only the builder changes files. The others also get read-only repository tokens. */
const CAN_WRITE: Record<RunnerRole, boolean> = {
  interviewer: false,
  spec: false,
  builder: true,
  reviewer_spec: false,
  reviewer_correctness: false,
  chooser: false,
  learner: false
};

const WRITE_TOOLS_OFF: AgentToolConfig[] = [
  { name: 'write', type: 'write', enabled: false },
  { name: 'edit', type: 'edit', enabled: false }
];

export const DEFAULT_MODEL = 'claude-opus-5';

export interface AgentDefinition {
  readonly role: RunnerRole;
  readonly name: string;
  readonly model: string;
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
  model: string = DEFAULT_MODEL
): AgentDefinition => {
  const disabled: AgentToolConfig[] = [
    // Web access is off for every role: task text is untrusted, and nothing here needs the web.
    { name: 'web_search', type: 'web_search', enabled: false },
    { name: 'web_fetch', type: 'web_fetch', enabled: false },
    ...(CAN_WRITE[role] ? [] : WRITE_TOOLS_OFF)
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
  const hash = createHash('sha256')
    .update(JSON.stringify({ name, model, system, tools }))
    .digest('hex');
  return { role, name, model, system, tools, hash };
};

/** Reads `agents/<role>.md` prompts from a directory and builds every runner role's definition. */
export const loadDefinitions = async (
  promptsDir: string,
  model: string = DEFAULT_MODEL
): Promise<AgentDefinition[]> =>
  Promise.all(
    RUNNER_ROLES.map(async (role) =>
      buildDefinition(role, await Bun.file(join(promptsDir, `${role}.md`)).text(), model)
    )
  );

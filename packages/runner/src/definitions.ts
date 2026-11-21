import { createHash } from 'node:crypto';
import { AGENT_ROLES, OUTPUT_SCHEMAS, isBuildRole, type AgentRole } from '@officina/core';
import type { AgentCreateParams } from '@anthropic-ai/sdk/resources/beta/agents/agents';
import { z } from 'zod';
import { PINNED_MODELS } from './models';
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

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentModel {
  readonly id: string;
  readonly effort: AgentEffort;
}

/**
 * Set explicitly because the default moves between releases (Opus 5.5 dropped it to medium), and
 * every role's output feeds a decision people rely on.
 */
export const AGENT_EFFORT: AgentEffort = 'high';

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
  modelId: string = PINNED_MODELS.opus,
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
  const model: AgentModel = { id: modelId, effort: AGENT_EFFORT };
  const hash = hashOf(
    reader ? { name, model, system, tools, reader: reader.hash } : { name, model, system, tools }
  );
  return { role, name, model, system, tools, reader, hash };
};

/**
 * Reads `agents/<role>.md` prompts from a directory and builds every runner role's definition, each
 * prompt followed by the code standard. The roles in `READER_ROLES` also get the reader, built from
 * `agents/reader.md` on `readerModelId`, and the rules for handing it work before the standard.
 */
export const loadDefinitions = async (
  promptsDir: string,
  modelId: string = PINNED_MODELS.opus,
  readerModelId: string = PINNED_MODELS.haiku
): Promise<AgentDefinition[]> => {
  const standard = await loadStandard();
  const reader = buildReaderDefinition(await loadPrompt(promptsDir, READER_PROMPT), readerModelId);
  return Promise.all(
    RUNNER_ROLES.map(async (role) => {
      const prompt = await loadPrompt(promptsDir, role);
      return hasReader(role)
        ? buildDefinition(role, withStandard(withReader(prompt), standard), modelId, reader)
        : buildDefinition(role, withStandard(prompt, standard), modelId);
    })
  );
};

/*
 * The narrow slice of the Managed Agents API (and the model list that picks the agents' model) the
 * runner uses. The engine and the tests depend on
 * this port; only `sdk.ts` knows the SDK.
 */

export interface SessionEvent {
  readonly type: string;
  readonly id: string;
  readonly [field: string]: unknown;
}

export type OutboundEvent =
  | { readonly type: 'user.message'; readonly text: string }
  | {
      readonly type: 'user.custom_tool_result';
      readonly toolUseId: string;
      readonly text: string;
      readonly isError: boolean;
    }
  | { readonly type: 'user.interrupt' };

export interface SessionRequest {
  readonly agentId: string;
  readonly agentVersion: number;
  readonly environmentId: string;
  readonly title: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly repository: {
    readonly url: string;
    readonly token: string;
    readonly branch: string;
  };
  readonly budgetCents: number;
}

import type { AgentModel, AgentTools } from './definitions';
import type { ListedModel } from './models';

/** A stored agent's exact version, as a roster pins it. */
export interface AgentVersionRef {
  readonly id: string;
  readonly version: number;
}

export interface AgentWrite {
  readonly name: string;
  readonly model: AgentModel;
  readonly system: string;
  readonly tools: AgentTools;
  /** The definition hash, kept on the agent so a later sync can tell whether it changed. */
  readonly hash: string;
  /** Agents this one may hand work to in its sessions; none when it works alone. */
  readonly roster: readonly AgentVersionRef[];
}

/** An agent found by name: its latest version and the definition hash that version was written from. */
export interface FoundAgent extends AgentVersionRef {
  readonly hash: string | null;
}

export interface EnvironmentWrite {
  readonly name: string;
  readonly allowedHosts: readonly string[];
}

export interface ManagedAgentsPort {
  findEnvironmentByName(name: string): Promise<{ id: string } | null>;
  createEnvironment(environment: EnvironmentWrite): Promise<{ id: string }>;
  updateEnvironment(environmentId: string, environment: EnvironmentWrite): Promise<void>;
  createSession(request: SessionRequest): Promise<{ id: string }>;
  openStream(sessionId: string): Promise<AsyncIterable<SessionEvent>>;
  send(sessionId: string, events: readonly OutboundEvent[]): Promise<void>;
  sessionCostCents(sessionId: string): Promise<number | null>;
  /** An agent with this name, so one created but never recorded is reused rather than duplicated. */
  findAgentByName(name: string): Promise<FoundAgent | null>;
  createAgent(agent: AgentWrite): Promise<{ id: string; version: number }>;
  updateAgent(agentId: string, agent: AgentWrite): Promise<{ id: string; version: number }>;
  listModels(): Promise<ListedModel[]>;
}

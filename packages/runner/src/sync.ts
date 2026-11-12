import type { AgentDefinition } from './definitions';
import type { EnvironmentWrite, ManagedAgentsPort } from './port';

export interface SyncedAgent {
  readonly role: string;
  readonly externalAgentId: string;
  readonly version: number;
  readonly definitionHash: string;
}

/**
 * Brings the runner's agents in line with the checked-in definitions: unchanged definitions are
 * left alone, changed ones become a new version of the same agent, missing ones are created.
 * `save` records each agent as soon as it is written, so a sync that fails partway does not create
 * the agents it already wrote a second time on the next run.
 */
export const syncAgents = async (
  port: ManagedAgentsPort,
  definitions: readonly AgentDefinition[],
  current: readonly SyncedAgent[],
  save: (agent: SyncedAgent) => Promise<void>
): Promise<{ agents: SyncedAgent[]; changed: string[] }> => {
  const byRole = new Map(current.map((agent) => [agent.role, agent]));
  const agents: SyncedAgent[] = [];
  const changed: string[] = [];
  for (const definition of definitions) {
    const existing = byRole.get(definition.role);
    if (existing && existing.definitionHash === definition.hash) {
      agents.push(existing);
      continue;
    }
    const write = {
      name: definition.name,
      model: definition.model,
      system: definition.system,
      tools: definition.tools
    };
    const saved = existing
      ? await port.updateAgent(existing.externalAgentId, write)
      : await port.createAgent(write);
    const synced: SyncedAgent = {
      role: definition.role,
      externalAgentId: saved.id,
      version: saved.version,
      definitionHash: definition.hash
    };
    await save(synced);
    agents.push(synced);
    changed.push(definition.role);
  }
  return { agents, changed };
};

/** Creates the environment, or brings an existing one with the same name up to date. */
export const ensureEnvironment = async (
  port: ManagedAgentsPort,
  environment: EnvironmentWrite
): Promise<{ id: string; created: boolean }> => {
  const existing = await port.findEnvironmentByName(environment.name);
  if (existing) {
    await port.updateEnvironment(existing.id, environment);
    return { id: existing.id, created: false };
  }
  return { ...(await port.createEnvironment(environment)), created: true };
};

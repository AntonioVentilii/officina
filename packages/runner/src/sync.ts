import type { AgentDefinition } from './definitions';
import type { ManagedAgentsPort } from './port';

export interface SyncedAgent {
  readonly role: string;
  readonly externalAgentId: string;
  readonly version: number;
  readonly definitionHash: string;
}

/**
 * Brings the runner's agents in line with the checked-in definitions: unchanged definitions are
 * left alone, changed ones become a new version of the same agent, missing ones are created.
 */
export const syncAgents = async (
  port: ManagedAgentsPort,
  definitions: readonly AgentDefinition[],
  current: readonly SyncedAgent[]
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
    agents.push({
      role: definition.role,
      externalAgentId: saved.id,
      version: saved.version,
      definitionHash: definition.hash
    });
    changed.push(definition.role);
  }
  return { agents, changed };
};

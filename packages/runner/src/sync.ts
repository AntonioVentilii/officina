import type { AgentDefinition, AgentShape } from './definitions';
import type { AgentVersionRef, EnvironmentWrite, ManagedAgentsPort } from './port';

export interface SyncedAgent {
  readonly role: string;
  readonly externalAgentId: string;
  readonly version: number;
  readonly definitionHash: string;
}

/**
 * The version of an agent to pin, kept by name rather than in the database: the one found by name
 * when it was written from the same definition, else a new version of it, or a new agent when none
 * has that name. A role's reader is kept this way, and so is every trial agent.
 */
export const syncByName = async (
  port: ManagedAgentsPort,
  agent: AgentShape,
  roster: readonly AgentVersionRef[] = []
): Promise<AgentVersionRef> => {
  const found = await port.findAgentByName(agent.name);
  if (found?.hash === agent.hash) return { id: found.id, version: found.version };
  const write = { ...agent, roster };
  const saved = found ? await port.updateAgent(found.id, write) : await port.createAgent(write);
  return { id: saved.id, version: saved.version };
};

/**
 * Brings the runner's agents in line with the checked-in definitions: unchanged definitions are
 * left alone, changed ones become a new version of the same agent, missing ones are created.
 * `save` records each agent as soon as it is written, so a sync that fails partway does not create
 * the agents it already wrote a second time on the next run; one written but never saved is found
 * by name and updated instead. A role with a reader is written after its reader, pinned to the
 * reader's version; the reader is synced once per call however many roles share it, and only when
 * one of them changed, since its hash is part of theirs.
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
  const readers = new Map<string, Promise<AgentVersionRef>>();
  const readerFor = (reader: AgentShape) => {
    let pending = readers.get(reader.name);
    if (!pending) {
      pending = syncByName(port, reader);
      readers.set(reader.name, pending);
    }
    return pending;
  };
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
      tools: definition.tools,
      hash: definition.hash,
      roster: definition.reader ? [await readerFor(definition.reader)] : []
    };
    // An agent created by an earlier sync whose save failed is found by name and updated.
    const id = existing?.externalAgentId ?? (await port.findAgentByName(definition.name))?.id;
    const saved = id ? await port.updateAgent(id, write) : await port.createAgent(write);
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

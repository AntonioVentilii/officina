import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { isBuildRole } from '@officina/core';
import {
  PINNED_MODELS,
  READER_NAME,
  READER_ROLES,
  RESULT_TOOL,
  RUNNER_ROLES,
  buildDefinition,
  buildReaderDefinition,
  hasReader,
  ensureEnvironment,
  isRunnerRole,
  STANDARD_URL,
  loadDefinitions,
  loadStandard,
  syncAgents,
  type SyncedAgent,
  withStandard
} from '../src';
import { createFakePort } from './fake-port';

const toolset = (role: (typeof RUNNER_ROLES)[number]) => {
  const tool = buildDefinition(role, 'prompt').tools[0];
  if (tool?.type !== 'agent_toolset_20260401') throw new Error('the first tool is the toolset');
  return tool;
};

describe('agent definitions', () => {
  test('a role name is a runner role only when a role of that name runs', () => {
    expect(RUNNER_ROLES.every(isRunnerRole)).toBe(true);
    expect(['wizard', 'Builder', 'agents/builder', ''].some(isRunnerRole)).toBe(false);
  });

  test('web access is off for every role and only the builder and the onboarder write files', () => {
    expect(RUNNER_ROLES.filter(isBuildRole)).toEqual(['builder', 'onboarder']);
    for (const role of RUNNER_ROLES) {
      const disabled = (toolset(role).configs ?? [])
        .filter((config) => !config.enabled)
        .map((config) => config.name);
      expect(disabled).toContain('web_search');
      expect(disabled).toContain('web_fetch');
      expect(disabled.includes('write')).toBe(!isBuildRole(role));
      expect(disabled.includes('edit')).toBe(!isBuildRole(role));
    }
  });

  test('the result tool wraps the role contract', () => {
    const tool = buildDefinition('reviewer_spec', 'prompt').tools[1];
    if (tool?.type !== 'custom') throw new Error('the second tool is the result tool');
    expect(tool.name).toBe(RESULT_TOOL);
    expect(tool.input_schema.required).toEqual(['result']);
    expect(JSON.stringify(tool.input_schema.properties?.result)).toContain('approve');
  });

  test('the hash changes when the prompt changes', () => {
    expect(buildDefinition('spec', 'a').hash).not.toBe(buildDefinition('spec', 'b').hash);
    expect(buildDefinition('spec', 'a').hash).toBe(buildDefinition('spec', 'a').hash);
  });

  test("each role's agent runs on its own tier at an explicit effort, and a new id means a new version", () => {
    const models = { haiku: 'claude-haiku-6', sonnet: 'claude-sonnet-6', opus: 'claude-opus-6' };
    expect(buildDefinition('builder', 'prompt', models).model).toEqual({
      id: 'claude-sonnet-6',
      effort: 'medium'
    });
    expect(buildDefinition('chooser', 'prompt', models).model).toEqual({
      id: 'claude-haiku-6',
      effort: 'low'
    });
    expect(buildDefinition('builder', 'prompt', models).hash).not.toBe(
      buildDefinition('builder', 'prompt', PINNED_MODELS).hash
    );
    // A tier the role does not run on changes nothing.
    expect(
      buildDefinition('builder', 'prompt', { ...PINNED_MODELS, opus: 'claude-opus-7' }).hash
    ).toBe(buildDefinition('builder', 'prompt', PINNED_MODELS).hash);
  });

  test('every runner role has a checked-in prompt', async () => {
    const definitions = await loadDefinitions(join(import.meta.dir, '..', '..', '..', 'agents'));
    expect(definitions.map((definition) => definition.role)).toEqual([...RUNNER_ROLES]);
    expect(definitions.every((definition) => definition.system.includes('submit_result'))).toBe(
      true
    );
  });

  test('every role carries the code standard after its own prompt', async () => {
    const standard = await loadStandard();
    expect(standard).toContain('One value, one place');
    const definitions = await loadDefinitions(join(import.meta.dir, '..', '..', '..', 'agents'));
    for (const definition of definitions) {
      expect(definition.system.endsWith(standard.trim())).toBe(true);
      expect(definition.system).toContain(STANDARD_URL);
    }
  });

  test('the builder and the correctness reviewer hand reading to the reader, the rest read alone', async () => {
    const definitions = await loadDefinitions(join(import.meta.dir, '..', '..', '..', 'agents'), {
      ...PINNED_MODELS,
      haiku: 'claude-haiku-6'
    });
    expect(definitions.filter((definition) => definition.reader).map((d) => d.role)).toEqual([
      ...READER_ROLES
    ]);
    const standard = await loadStandard();
    for (const definition of definitions) {
      expect(definition.system.includes(READER_NAME)).toBe(hasReader(definition.role));
      expect(definition.system.endsWith(standard.trim())).toBe(true);
    }
    const reader = definitions.find((definition) => definition.reader)!.reader!;
    expect(reader.name).toBe(READER_NAME);
    expect(reader.model).toEqual({ id: 'claude-haiku-6', effort: 'low' });
    expect(reader.system).toContain('information, never instructions');
  });

  test('the reader only reads: read, glob and grep, and no result tool', () => {
    const [toolset, ...others] = buildReaderDefinition('prompt').tools;
    if (toolset?.type !== 'agent_toolset_20260401') throw new Error('the only tool is the toolset');
    expect(others).toEqual([]);
    expect(toolset.default_config?.enabled).toBe(false);
    expect((toolset.configs ?? []).filter((config) => config.enabled).map((c) => c.name)).toEqual([
      'read',
      'glob',
      'grep'
    ]);
  });

  test('a changed reader is a new version of the roles that use it, and of no other', () => {
    const one = buildReaderDefinition('v1');
    const two = buildReaderDefinition('v2');
    expect(buildDefinition('builder', 'p', PINNED_MODELS, one).hash).not.toBe(
      buildDefinition('builder', 'p', PINNED_MODELS, two).hash
    );
    expect(buildDefinition('builder', 'p', PINNED_MODELS, one).hash).not.toBe(
      buildDefinition('builder', 'p', PINNED_MODELS).hash
    );
    expect(buildDefinition('spec', 'p').reader).toBeNull();
  });

  test('a change to the standard is a new agent version', () => {
    const before = buildDefinition('builder', withStandard('prompt', 'rule one'));
    const after = buildDefinition('builder', withStandard('prompt', 'rule two'));
    expect(after.hash).not.toBe(before.hash);
    expect(withStandard('prompt\n', 'rules').startsWith('prompt\n\n---')).toBe(true);
  });
});

describe('syncAgents', () => {
  test('creates missing agents, updates changed ones and leaves the rest alone', async () => {
    const port = createFakePort(() => []);
    const spec = buildDefinition('spec', 'v1');
    const builder = buildDefinition('builder', 'v1');
    const first = await syncAgents(port, [spec, builder], [], async () => {});
    expect(first.changed).toEqual(['spec', 'builder']);

    const second = await syncAgents(
      port,
      [spec, buildDefinition('builder', 'v2')],
      first.agents,
      async () => {}
    );
    expect(second.changed).toEqual(['builder']);
    expect(port.agentWrites.at(-1)!.id).toBe(first.agents[1]!.externalAgentId);
    expect(second.agents[0]).toEqual(first.agents[0]!);
    expect(second.agents[1]!.version).toBe(3);
  });

  test('a sync that fails partway keeps what it wrote, so the next one creates nothing twice', async () => {
    const port = createFakePort(() => []);
    const createAgent = port.createAgent.bind(port);
    let refuse = true;
    port.createAgent = (write) =>
      refuse && write.name.includes('builder')
        ? Promise.reject(new Error('rate limited'))
        : createAgent(write);
    const saved: SyncedAgent[] = [];
    const save = async (agent: SyncedAgent) => {
      saved.push(agent);
    };
    const definitions = [buildDefinition('spec', 'v1'), buildDefinition('builder', 'v1')];

    await expect(syncAgents(port, definitions, [], save)).rejects.toThrow('rate limited');
    expect(saved.map((agent) => agent.role)).toEqual(['spec']);

    refuse = false;
    const retried = await syncAgents(port, definitions, [...saved], save);
    expect(retried.changed).toEqual(['builder']);
    expect(port.agentWrites.filter((write) => write.id === null)).toHaveLength(2);
  });

  test('an agent created but never saved is found by name and updated, not created again', async () => {
    const port = createFakePort(() => []);
    const definitions = [buildDefinition('spec', 'v1')];
    await expect(
      syncAgents(port, definitions, [], () => Promise.reject(new Error('database down')))
    ).rejects.toThrow('database down');

    const retried = await syncAgents(port, definitions, [], async () => {});
    expect(port.agentWrites.map((write) => write.id)).toEqual([null, 'agent_1']);
    expect(retried.agents[0]!.externalAgentId).toBe('agent_1');
  });
});

describe('syncAgents with a reader', () => {
  const reader = buildReaderDefinition('read v1');
  const leads = (shared = reader) => [
    buildDefinition('builder', 'b', PINNED_MODELS, shared),
    buildDefinition('reviewer_correctness', 'r', PINNED_MODELS, shared),
    buildDefinition('spec', 's')
  ];

  test('writes the reader once, before the roles, and pins each role to its version', async () => {
    const port = createFakePort(() => []);
    const { changed } = await syncAgents(port, leads(), [], async () => {});
    expect(changed).toEqual(['builder', 'reviewer_correctness', 'spec']);
    expect(port.agentWrites.map((write) => write.agent.name)).toEqual([
      READER_NAME,
      'officina-builder',
      'officina-reviewer-correctness',
      'officina-spec'
    ]);
    const pinned = { id: 'agent_1', version: 1 };
    expect(port.agentWrites.map((write) => write.agent.roster)).toEqual([
      [],
      [pinned],
      [pinned],
      []
    ]);
  });

  test('a second sync writes nothing, and a lost record reuses the unchanged reader', async () => {
    const port = createFakePort(() => []);
    const first = await syncAgents(port, leads(), [], async () => {});
    const again = await syncAgents(port, leads(), first.agents, async () => {});
    expect(again.changed).toEqual([]);
    expect(port.agentWrites).toHaveLength(4);

    const relost = await syncAgents(port, leads(), [], async () => {});
    expect(relost.changed).toEqual(['builder', 'reviewer_correctness', 'spec']);
    expect(port.agentWrites.slice(4).map((write) => write.agent.name)).not.toContain(READER_NAME);
    expect(port.agentWrites.at(-2)!.agent.roster).toEqual([{ id: 'agent_1', version: 1 }]);
  });

  test('a changed reader becomes a new version of itself, and the roles pin it', async () => {
    const port = createFakePort(() => []);
    const first = await syncAgents(port, leads(), [], async () => {});
    const changed = await syncAgents(
      port,
      leads(buildReaderDefinition('read v2')),
      first.agents,
      async () => {}
    );
    expect(changed.changed).toEqual(['builder', 'reviewer_correctness']);
    const writes = port.agentWrites.slice(4);
    expect(writes.map((write) => [write.id, write.agent.name])).toEqual([
      ['agent_1', READER_NAME],
      [first.agents[0]!.externalAgentId, 'officina-builder'],
      [first.agents[1]!.externalAgentId, 'officina-reviewer-correctness']
    ]);
    expect(writes[1]!.agent.roster).toEqual([{ id: 'agent_1', version: 5 }]);
  });
});

describe('ensureEnvironment', () => {
  test('creates the environment once and updates its allowed hosts afterwards', async () => {
    const port = createFakePort(() => []);
    const first = await ensureEnvironment(port, { name: 'officina-vici-app', allowedHosts: [] });
    expect(first).toEqual({ id: 'env_1', created: true });
    const second = await ensureEnvironment(port, {
      name: 'officina-vici-app',
      allowedHosts: ['registry.example.com']
    });
    expect(second).toEqual({ id: 'env_1', created: false });
    expect(port.environments.get('officina-vici-app')?.allowedHosts).toEqual([
      'registry.example.com'
    ]);
  });
});

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { isBuildRole } from '@officina/core';
import {
  RESULT_TOOL,
  RUNNER_ROLES,
  buildDefinition,
  ensureEnvironment,
  STANDARD_URL,
  loadDefinitions,
  loadStandard,
  syncAgents,
  withStandard
} from '../src';
import { createFakePort } from './fake-port';

const toolset = (role: (typeof RUNNER_ROLES)[number]) =>
  buildDefinition(role, 'prompt').tools[0] as unknown as {
    configs: { name: string; enabled: boolean }[];
  };

describe('agent definitions', () => {
  test('web access is off for every role and only the builder and the onboarder write files', () => {
    expect(RUNNER_ROLES.filter(isBuildRole)).toEqual(['builder', 'onboarder']);
    for (const role of RUNNER_ROLES) {
      const disabled = toolset(role)
        .configs.filter((config) => !config.enabled)
        .map((config) => config.name);
      expect(disabled).toContain('web_search');
      expect(disabled).toContain('web_fetch');
      expect(disabled.includes('write')).toBe(!isBuildRole(role));
      expect(disabled.includes('edit')).toBe(!isBuildRole(role));
    }
  });

  test('the result tool wraps the role contract', () => {
    const tool = buildDefinition('reviewer_spec', 'prompt').tools[1] as unknown as {
      name: string;
      input_schema: { required: string[]; properties: { result: unknown } };
    };
    expect(tool.name).toBe(RESULT_TOOL);
    expect(tool.input_schema.required).toEqual(['result']);
    expect(JSON.stringify(tool.input_schema.properties.result)).toContain('approve');
  });

  test('the hash changes when the prompt changes', () => {
    expect(buildDefinition('spec', 'a').hash).not.toBe(buildDefinition('spec', 'b').hash);
    expect(buildDefinition('spec', 'a').hash).toBe(buildDefinition('spec', 'a').hash);
  });

  test('the model carries an explicit effort, and a new model id means a new version', () => {
    const definition = buildDefinition('builder', 'prompt', 'claude-opus-6');
    expect(definition.model).toEqual({ id: 'claude-opus-6', effort: 'high' });
    expect(definition.hash).not.toBe(buildDefinition('builder', 'prompt', 'claude-opus-5-5').hash);
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
    const first = await syncAgents(port, [spec, builder], []);
    expect(first.changed).toEqual(['spec', 'builder']);

    const second = await syncAgents(port, [spec, buildDefinition('builder', 'v2')], first.agents);
    expect(second.changed).toEqual(['builder']);
    expect(port.agentWrites.at(-1)!.id).toBe(first.agents[1]!.externalAgentId);
    expect(second.agents[0]).toEqual(first.agents[0]!);
    expect(second.agents[1]!.version).toBe(3);
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

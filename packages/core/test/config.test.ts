import { describe, expect, test } from 'bun:test';
import { parseProjectConfig, parseProjectConfigYaml } from '../src';
import { loadConfig } from './fixtures';

describe('project config', () => {
  test('fills lane defaults for a minimal config', () => {
    const result = parseProjectConfig({ version: 1, docs: { entry: 'AGENTS.md' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.lanes.standard).toMatchObject({ agentsBuild: true, wip: 3, fixRounds: 2 });
    expect(result.config.lanes.standard.approvals.spec_review).toEqual([{ role: 'maintainer' }]);
    expect(result.config.docs.specTemplate).toBeNull();
  });

  test('red lane never lets agents build, even when config asks for it', () => {
    const result = parseProjectConfig({
      version: 1,
      docs: { entry: 'AGENTS.md' },
      lanes: { red: { paths: ['infra/**'], agents_build: true } }
    });
    expect(result.ok && result.config.lanes.red.agentsBuild).toBe(false);
  });

  test('reports unknown keys and bad requirements with their path', () => {
    const result = parseProjectConfig({
      version: 1,
      docs: { entry: 'AGENTS.md' },
      lanes: { green: { approvals: { verifying: [{ role: 'contributor' }] } }, blue: {} }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.startsWith('lanes'))).toBe(true);
  });

  test('rejects invalid YAML without throwing', () => {
    const result = parseProjectConfigYaml('version: [1');
    expect(result.ok).toBe(false);
  });

  test('parses the fixture used by the lifecycle tests', () => {
    const config = loadConfig();
    expect(config.lanes.green.approvals.spec_review).toEqual([
      { requester: true },
      { domain: 'product' }
    ]);
  });
});

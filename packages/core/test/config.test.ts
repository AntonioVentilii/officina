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
    expect(result.config.runtime.allowedHosts).toEqual([]);
  });

  test('assumes a merge deploys to production, and nothing verifies itself, unless told', () => {
    const result = parseProjectConfig({ version: 1, docs: { entry: 'AGENTS.md' } });
    expect(result.ok && result.config.release.onMerge).toBe('production');
    expect(result.ok && result.config.lanes.green.autoVerify).toBe(false);
  });

  test('auto_verify is a green-lane setting only', () => {
    const green = parseProjectConfig({
      version: 1,
      docs: { entry: 'AGENTS.md' },
      release: { on_merge: 'staging' },
      lanes: { green: { paths: ['copy/**'], auto_verify: true } }
    });
    expect(green.ok && green.config.lanes.green.autoVerify).toBe(true);
    expect(green.ok && green.config.release.onMerge).toBe('staging');
    const standard = parseProjectConfig({
      version: 1,
      docs: { entry: 'AGENTS.md' },
      lanes: { standard: { auto_verify: true } }
    });
    expect(standard).toEqual({
      ok: false,
      errors: ['lanes: auto_verify is only allowed in the green lane']
    });
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

  test('defaults the board look to modernista and rejects an unknown look', () => {
    const plain = parseProjectConfig({ version: 1, docs: { entry: 'AGENTS.md' } });
    expect(plain.ok && plain.config.board.look).toBe('modernista');
    const tecnica = parseProjectConfig({
      version: 1,
      docs: { entry: 'AGENTS.md' },
      board: { look: 'tecnica' }
    });
    expect(tecnica.ok && tecnica.config.board.look).toBe('tecnica');
    const unknown = parseProjectConfig({
      version: 1,
      docs: { entry: 'AGENTS.md' },
      board: { look: 'neon' }
    });
    expect(unknown.ok).toBe(false);
  });

  test('accepts a pull request title pattern and rejects one that is not a valid regex', () => {
    const valid = parseProjectConfig({
      version: 1,
      docs: { entry: 'AGENTS.md' },
      pull_request: { title_pattern: '^fix\\(.+\\): .+$' }
    });
    expect(valid.ok && valid.config.pullRequest.titlePattern).toBe('^fix\\(.+\\): .+$');
    const invalid = parseProjectConfig({
      version: 1,
      docs: { entry: 'AGENTS.md' },
      pull_request: { title_pattern: '^fix(' }
    });
    expect(invalid.ok).toBe(false);
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

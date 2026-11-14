import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_STANDARDS_PAGES,
  isAgentDocsPath,
  isStandardsPage,
  parseProjectConfig,
  parseProjectConfigYaml,
  requiredDocs
} from '../src';
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

  test('asks for the default agent docs pages in docs/ai unless told otherwise', () => {
    const result = parseProjectConfig({ version: 1, docs: { entry: 'AGENTS.md' } });
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.config.docs.standards).toEqual({
      dir: 'docs/ai',
      pages: DEFAULT_STANDARDS_PAGES.map((page) => `docs/ai/${page}`),
      catalogs: []
    });
    expect(requiredDocs(result.config)).toEqual([
      'AGENTS.md',
      ...DEFAULT_STANDARDS_PAGES.map((page) => `docs/ai/${page}`)
    ]);
  });

  test('a project names its own docs folder, pages and catalogs, each page required once', () => {
    const result = parseProjectConfig({
      version: 1,
      docs: {
        entry: 'AGENTS.md',
        standards: 'docs/agents/',
        pages: ['README.md', 'frontend/reusability.md'],
        catalogs: {
          'src/lib/components/**': 'frontend/reusability.md',
          'src/lib/utils/**': 'utils.md'
        }
      }
    });
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.config.docs.standards.catalogs).toEqual([
      { pattern: 'src/lib/components/**', page: 'docs/agents/frontend/reusability.md' },
      { pattern: 'src/lib/utils/**', page: 'docs/agents/utils.md' }
    ]);
    expect(requiredDocs(result.config)).toEqual([
      'AGENTS.md',
      'docs/agents/README.md',
      'docs/agents/frontend/reusability.md',
      'docs/agents/utils.md'
    ]);
  });

  test('the agent docs are the entry document, the tool layers and the docs folder', () => {
    const result = parseProjectConfig({ version: 1, docs: { entry: 'AGENTS.md' } });
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const docs = ['AGENTS.md', 'CLAUDE.md', 'docs/ai/patterns.md', 'docs/ai/workflows/x.md'];
    expect(docs.every((path) => isAgentDocsPath(result.config, path))).toBe(true);
    // The pages agents learn from leave the tool layers out: those only point at the entry.
    expect(docs.filter((path) => isStandardsPage(result.config, path))).toEqual([
      'AGENTS.md',
      'docs/ai/patterns.md',
      'docs/ai/workflows/x.md'
    ]);
    expect(
      ['docs/aide.md', 'src/AGENTS.md', 'docs/ai'].some((path) =>
        isAgentDocsPath(result.config, path)
      )
    ).toBe(false);
  });

  test('agent docs pages are Markdown inside the repository', () => {
    const result = parseProjectConfig({
      version: 1,
      docs: { entry: 'AGENTS.md', standards: '../elsewhere', pages: ['notes.txt'] }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      'docs.standards: must be a relative path inside the repository',
      'docs.pages.0: must be a Markdown page'
    ]);
  });

  test('the entry document is a repository path too, so pushed paths can match it', () => {
    // Push facts name paths from the repository root; an entry written with a leading slash
    // would never be recognised as part of the agent docs.
    const result = parseProjectConfig({ version: 1, docs: { entry: '/AGENTS.md' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(['docs.entry: must be a relative path inside the repository']);
    expect(parseProjectConfig({ version: 1, docs: { entry: 'AGENTS' } }).ok).toBe(false);
  });

  test('assumes a merge deploys to production, and nothing verifies itself, unless told', () => {
    const result = parseProjectConfig({ version: 1, docs: { entry: 'AGENTS.md' } });
    expect(result.ok && result.config.release.onMerge).toBe('production');
    expect(result.ok && result.config.lanes.green.autoVerify).toBe(false);
  });

  test('auto-merge is off unless the project turns it on', () => {
    const off = parseProjectConfig({ version: 1, docs: { entry: 'AGENTS.md' } });
    expect(off.ok && off.config.pullRequest.autoMerge).toBe(false);
    const on = parseProjectConfig({
      version: 1,
      docs: { entry: 'AGENTS.md' },
      pull_request: { auto_merge: true }
    });
    expect(on.ok && on.config.pullRequest.autoMerge).toBe(true);
  });

  test('no review bot is listed unless the project names its own', () => {
    const none = parseProjectConfig({ version: 1, docs: { entry: 'AGENTS.md' } });
    expect(none.ok && none.config.pullRequest.reviewBots).toEqual([]);
    const listed = parseProjectConfig({
      version: 1,
      docs: { entry: 'AGENTS.md' },
      pull_request: { review_bots: ['coderabbitai[bot]', 'claude[bot]'] }
    });
    expect(listed.ok && listed.config.pullRequest.reviewBots).toEqual([
      'coderabbitai[bot]',
      'claude[bot]'
    ]);
    expect(
      parseProjectConfig({
        version: 1,
        docs: { entry: 'AGENTS.md' },
        pull_request: { review_bots: [''] }
      }).ok
    ).toBe(false);
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

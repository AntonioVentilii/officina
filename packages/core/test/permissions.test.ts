import { describe, expect, test } from 'bun:test';
import {
  ACTIONS,
  ACTION_LABELS,
  ROLES,
  allowedActions,
  can,
  canAnswer,
  readsTask,
  seesQuestion
} from '../src';

describe('permission matrix', () => {
  test('each role may do exactly what the matrix says', () => {
    expect(ROLES.map((role) => ({ role, actions: allowedActions({ role }) }))).toEqual([
      { role: 'watcher', actions: ['see'] },
      {
        role: 'contributor',
        actions: ['see', 'request', 'comment', 'answer', 'approve_spec', 'verify_result']
      },
      {
        role: 'maintainer',
        actions: [
          'see',
          'request',
          'comment',
          'answer',
          'approve_spec',
          'verify_result',
          'triage',
          'build',
          'steer',
          'see_runs',
          'decide_learnings',
          'merge',
          'see_confidential'
        ]
      },
      { role: 'owner', actions: [...ACTIONS] }
    ]);
  });

  test('every member sees every task; only contributors and above act on them', () => {
    expect(can({ role: 'watcher' }, 'see')).toBe(true);
    expect(can({ role: 'watcher' }, 'request')).toBe(false);
    expect(can({ role: 'contributor' }, 'triage')).toBe(false);
    expect(can({ role: 'maintainer' }, 'manage_members')).toBe(false);
    expect(allowedActions({ role: 'owner' })).toContain('manage_members');
    expect(can({ role: 'maintainer' }, 'publish')).toBe(false);
  });

  test('a domain can grant one action below its role, and only that one', () => {
    const ceo = { role: 'contributor', domains: ['confidential'] } as const;
    expect(can(ceo, 'see_confidential')).toBe(true);
    expect(can({ role: 'contributor', domains: [] }, 'see_confidential')).toBe(false);
    // A domain grants nothing below contributor: a watcher with it still only reads the board.
    expect(can({ role: 'watcher', domains: ['confidential'] }, 'see_confidential')).toBe(false);
    expect(allowedActions(ceo)).not.toContain('publish');
  });

  test('the developer domain lets a contributor build, and nothing more', () => {
    const developer = { role: 'contributor', domains: ['developer'] } as const;
    expect(can(developer, 'build')).toBe(true);
    expect(can({ role: 'contributor', domains: [] }, 'build')).toBe(false);
    // A domain grants nothing below contributor: a watcher with it still only reads the board.
    expect(can({ role: 'watcher', domains: ['developer'] }, 'build')).toBe(false);
    expect(allowedActions(developer)).toEqual([
      'see',
      'request',
      'comment',
      'answer',
      'approve_spec',
      'verify_result',
      'build'
    ]);
  });

  test('a question is answered by whoever it is asked of, or by an owner', () => {
    const gio = { id: 'gio', role: 'contributor', domains: [] } as const;
    const watcher = { id: 'wes', role: 'watcher', domains: [] } as const;
    const owner = { id: 'ana', role: 'owner', domains: [] } as const;
    expect(canAnswer(gio, { memberId: 'gio' })).toBe(true);
    expect(canAnswer(gio, { memberId: 'ana' })).toBe(false);
    expect(canAnswer(gio, { role: 'maintainer' })).toBe(false);
    expect(canAnswer(watcher, { memberId: 'wes' })).toBe(false);
    expect(canAnswer(owner, { memberId: 'gio' })).toBe(true);
    expect(seesQuestion(gio, { role: 'maintainer' })).toBe(false);
    expect(seesQuestion(watcher, { memberId: 'wes' })).toBe(true);
    expect(seesQuestion({ id: 'mia', role: 'maintainer' }, { memberId: 'gio' })).toBe(true);
  });

  test('a confidential task is read only by members who may see confidential content', () => {
    const confidential = { guards: ['confidential'] } as const;
    expect(readsTask({ role: 'contributor' }, { guards: ['secrets'] })).toBe(true);
    expect(readsTask({ role: 'contributor' }, confidential)).toBe(false);
    expect(readsTask({ role: 'contributor', domains: ['confidential'] }, confidential)).toBe(true);
    expect(readsTask({ role: 'maintainer' }, confidential)).toBe(true);
  });

  test('every action has words people read', () => {
    for (const action of ACTIONS) expect(ACTION_LABELS[action].length).toBeGreaterThan(0);
  });

  test('the table in docs/architecture.md is the matrix the code enforces', async () => {
    const doc = await Bun.file(new URL('../../../docs/architecture.md', import.meta.url)).text();
    const section = doc.slice(doc.indexOf('## 2. People and roles'), doc.indexOf('## 3.'));
    const rows = section
      .split('\n')
      .filter((line) => /^\| `[a-z_]+` /.test(line))
      .map((line) =>
        line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim())
      );
    expect(rows).toEqual(
      ACTIONS.map((action) => [
        `\`${action}\``,
        ACTION_LABELS[action],
        ...ROLES.map((role) => (can({ role }, action) ? 'yes' : 'no'))
      ])
    );
  });
});

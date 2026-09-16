import { describe, expect, test } from 'bun:test';
import { evaluatePolicy, type Member, type Policy } from '../src';
import { owner, productContributor, watcher } from './fixtures';

const policy: Policy = [{ requester: true }, { domain: 'product' }];

describe('approval policies', () => {
  test('solo owner: requirements nobody can meet are waived, the owner approval is enough', () => {
    const result = evaluatePolicy(policy, [{ memberId: 'antonio', subject: 'spec:1' }], {
      members: [owner],
      requesterId: 'antonio',
      userVisible: true,
      subject: 'spec:1'
    });
    expect(result.satisfied).toBe(true);
    expect(result.waived).toEqual([{ domain: 'product' }]);
  });

  test('once a product member exists, their approval becomes required', () => {
    const context = {
      members: [owner, productContributor],
      requesterId: 'antonio',
      userVisible: true,
      subject: 'spec:1'
    };
    const ownerOnly = evaluatePolicy(policy, [{ memberId: 'antonio', subject: 'spec:1' }], context);
    expect(ownerOnly.satisfied).toBe(false);
    expect(ownerOnly.pending).toEqual([{ domain: 'product' }]);

    const both = evaluatePolicy(
      policy,
      [
        { memberId: 'antonio', subject: 'spec:1' },
        { memberId: 'gio', subject: 'spec:1' }
      ],
      context
    );
    expect(both.satisfied).toBe(true);
  });

  test('approvals on another subject do not count', () => {
    const result = evaluatePolicy([], [{ memberId: 'antonio', subject: 'spec:1' }], {
      members: [owner],
      requesterId: 'antonio',
      userVisible: false,
      subject: 'spec:2'
    });
    expect(result.satisfied).toBe(false);
  });

  test('user_visible requirements only apply to user-visible changes', () => {
    const visibleOnly: Policy = [{ domain: 'product', when: 'user_visible' }];
    const approvals = [{ memberId: 'antonio', subject: 'sha:1' }];
    const base = { members: [owner, productContributor], requesterId: 'antonio', subject: 'sha:1' };
    expect(evaluatePolicy(visibleOnly, approvals, { ...base, userVisible: false }).satisfied).toBe(
      true
    );
    expect(evaluatePolicy(visibleOnly, approvals, { ...base, userVisible: true }).satisfied).toBe(
      false
    );
  });

  test('watchers cannot satisfy anything, and the maintainer floor is never waived', () => {
    const contributorsOnly: Member[] = [productContributor, watcher];
    const result = evaluatePolicy(
      [{ requester: true }],
      [
        { memberId: 'gio', subject: 'spec:1' },
        { memberId: 'visitor', subject: 'spec:1' }
      ],
      { members: contributorsOnly, requesterId: 'gio', userVisible: false, subject: 'spec:1' }
    );
    expect(result.satisfied).toBe(false);
    expect(result.pending).toEqual([{ role: 'maintainer' }]);
  });
});

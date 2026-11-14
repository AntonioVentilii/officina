import { describe, expect, test } from 'bun:test';
import {
  APPROVAL_FLOOR,
  eligibleMembers,
  evaluatePolicy,
  outranks,
  type Member,
  type Policy
} from '../src';
import { owner, productContributor, watcher } from './fixtures';

const policy: Policy = [{ requester: true }, { domain: 'product' }];

/** Today's default: the requester's approval meets every requirement they are eligible for. */
const gate = { gate: 'spec_review', selfApproval: true, guards: [] } as const;

describe('approval policies', () => {
  test('solo owner: requirements nobody can meet are waived, the owner approval is enough', () => {
    const result = evaluatePolicy(policy, [{ memberId: 'antonio', subject: 'spec:1' }], {
      ...gate,
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
      ...gate,
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
      ...gate,
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
    const base = {
      ...gate,
      members: [owner, productContributor],
      requesterId: 'antonio',
      subject: 'sha:1'
    };
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
      {
        ...gate,
        members: contributorsOnly,
        requesterId: 'gio',
        userVisible: false,
        subject: 'spec:1'
      }
    );
    expect(result.satisfied).toBe(false);
    expect(result.pending).toEqual([{ role: 'maintainer' }]);
  });

  test('a gate counts only members the permission matrix lets take its action', () => {
    const context = { ...gate, members: [owner, watcher], requesterId: 'visitor' };
    expect(eligibleMembers({ requester: true }, context)).toEqual([]);
  });

  test('an owner requirement outranks the maintainer floor, and nothing else outranks anything', () => {
    expect(outranks({ role: 'owner' }, APPROVAL_FLOOR)).toBe(true);
    expect(outranks(APPROVAL_FLOOR, { role: 'owner' })).toBe(false);
    expect(outranks(APPROVAL_FLOOR, { role: 'maintainer' })).toBe(false);
    expect(outranks({ role: 'owner' }, { domain: 'product' })).toBe(false);
    expect(outranks({ role: 'owner' }, { requester: true })).toBe(false);
  });
});

describe('without self-approval', () => {
  const maintainer: Member = { id: 'marco', role: 'maintainer', domains: [] };
  const requesterOwner: Member = { id: 'antonio', role: 'owner', domains: ['product'] };
  const context = {
    gate: 'verifying',
    requesterId: 'antonio',
    userVisible: true,
    subject: 'sha:1',
    selfApproval: false,
    guards: []
  } as const;
  const own = [{ memberId: 'antonio', subject: 'sha:1' }];

  test("the requester's approval meets only the requester requirement while others can approve", () => {
    const result = evaluatePolicy([{ requester: true }, { domain: 'product' }], own, {
      ...context,
      members: [requesterOwner, maintainer, productContributor]
    });
    expect(result.pending).toEqual([{ domain: 'product' }, { role: 'maintainer' }]);

    const withOthers = evaluatePolicy(
      [{ requester: true }, { domain: 'product' }],
      [...own, { memberId: 'gio', subject: 'sha:1' }, { memberId: 'marco', subject: 'sha:1' }],
      { ...context, members: [requesterOwner, maintainer, productContributor] }
    );
    expect(withOthers.satisfied).toBe(true);
  });

  test('the requester still meets what nobody else can, so a small team is never stuck', () => {
    const result = evaluatePolicy([{ domain: 'product' }], own, {
      ...context,
      members: [requesterOwner, productContributor]
    });
    // Gio holds product, so the domain needs him; nobody else is a maintainer, so the floor is met.
    expect(result.pending).toEqual([{ domain: 'product' }]);
    expect(
      eligibleMembers({ role: 'maintainer' }, { ...context, members: [requesterOwner] })
    ).toEqual([requesterOwner]);
  });

  test('with self-approval on, the same approval meets every requirement it is eligible for', () => {
    const result = evaluatePolicy([{ domain: 'product' }], own, {
      ...context,
      selfApproval: true,
      members: [requesterOwner, maintainer, productContributor]
    });
    expect(result.satisfied).toBe(true);
  });
});

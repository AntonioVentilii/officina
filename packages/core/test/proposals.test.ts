import { describe, expect, test } from 'bun:test';
import {
  decide,
  memberActor,
  openProposals,
  type ApprovalProposal,
  type ProposalEntry,
  type Task
} from '../src';
import { PLAN, asAgent, asMember, createDriver, newTask, owner, watcher } from './fixtures';

const CLAUDE = { grantId: 'grant-1', name: 'Claude' };
const throughClaude = memberActor(owner.id, CLAUDE);

/** A task waiting for its plan to be approved, with the approval chooser's plan in place. */
const inSpecReview = (driver: ReturnType<typeof createDriver>): Task => {
  let task = newTask('t1', owner.id);
  task = driver.step(task, { type: 'submit_request' }, asMember(owner));
  task = driver.step(task, { type: 'accept' }, asMember(owner));
  task = driver.step(
    task,
    { type: 'post_spec', predictedPaths: ['src/routes/+page.svelte'], userVisible: false },
    asAgent('spec')
  );
  return driver.step(
    task,
    { type: 'plan_approval', userVisible: false, plan: PLAN },
    asAgent('chooser')
  );
};

describe('approvals through a connected app', () => {
  const driver = createDriver([owner, watcher]);
  const decideWith = (
    task: Task,
    proposals: readonly ApprovalProposal[],
    command: 'propose_approval' | 'discard_proposal',
    actor = throughClaude
  ) =>
    decide(task, { type: command }, actor, {
      config: driver.config,
      members: [owner, watcher],
      approvals: [],
      onboardingOpen: false,
      proposals
    });

  test('an approval through Claude is refused: it must be confirmed on the board', () => {
    const task = inSpecReview(driver);
    expect(driver.attempt(task, { type: 'approve' }, throughClaude)).toEqual({
      ok: false,
      error: 'confirm_on_board'
    });
  });

  test('Claude proposes an approval, which changes nothing until the member approves', () => {
    const task = inSpecReview(driver);
    const proposed = decideWith(task, [], 'propose_approval');
    expect(proposed).toEqual({
      ok: true,
      task,
      events: [
        { type: 'approval_proposed', gate: 'spec_review', subject: 'spec:1', memberId: owner.id }
      ]
    });
    // Proposed again, it is the same proposal.
    const open = [
      { gate: 'spec_review' as const, subject: 'spec:1', memberId: owner.id, via: CLAUDE }
    ];
    expect(decideWith(task, open, 'propose_approval')).toEqual({ ok: true, task, events: [] });
    // The member's own approval on the board is what counts.
    expect(driver.attempt(task, { type: 'approve' }, asMember(owner))).toMatchObject({ ok: true });
  });

  test('a proposal asks what an approval asks: on the board, or from someone who may not approve, it is refused', () => {
    const task = inSpecReview(driver);
    expect(decideWith(task, [], 'propose_approval', asMember(owner))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(decideWith(task, [], 'propose_approval', memberActor(watcher.id, CLAUDE))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
  });

  test('the member discards a proposal that waits, and only one that waits', () => {
    const task = inSpecReview(driver);
    expect(decideWith(task, [], 'discard_proposal', asMember(owner))).toEqual({
      ok: false,
      error: 'no_proposal'
    });
    const open = [
      { gate: 'spec_review' as const, subject: 'spec:1', memberId: owner.id, via: CLAUDE }
    ];
    expect(decideWith(task, open, 'discard_proposal', asMember(owner))).toEqual({
      ok: true,
      task,
      events: [
        {
          type: 'approval_proposal_discarded',
          gate: 'spec_review',
          subject: 'spec:1',
          memberId: owner.id
        }
      ]
    });
  });
});

describe('open proposals', () => {
  const at = { stage: 'spec_review', specVersion: 2, headSha: null } as const;
  const proposed = (subject: string): ProposalEntry => ({
    type: 'approval_proposed',
    gate: 'spec_review',
    subject,
    memberId: owner.id,
    via: CLAUDE
  });

  test('a proposal waits until it is discarded or met by the member approving the same subject', () => {
    expect(openProposals(at, [proposed('spec:2')], [])).toEqual([
      { gate: 'spec_review', subject: 'spec:2', memberId: owner.id, via: CLAUDE }
    ]);
    const discarded: ProposalEntry = {
      type: 'approval_proposal_discarded',
      gate: 'spec_review',
      subject: 'spec:2',
      memberId: owner.id
    };
    expect(openProposals(at, [proposed('spec:2'), discarded], [])).toEqual([]);
    expect(
      openProposals(at, [proposed('spec:2')], [{ memberId: owner.id, subject: 'spec:2' }])
    ).toEqual([]);
  });

  test('a new spec version or another stage leaves an older proposal behind', () => {
    expect(openProposals(at, [proposed('spec:1')], [])).toEqual([]);
    expect(openProposals({ ...at, stage: 'ready' }, [proposed('spec:2')], [])).toEqual([]);
  });
});

import { describe, expect, test } from 'bun:test';
import {
  canAutoVerify,
  effectivePolicy,
  humanBuildReason,
  newTask,
  nextAgentRoles,
  type Member,
  type PlanInput,
  type Task
} from '../src';
import {
  CONFIG_YAML,
  PLAN,
  asAgent,
  asMember,
  createDriver,
  engine,
  loadConfig,
  owner,
  productContributor,
  watcher
} from './fixtures';

const COPY_PATHS = ['src/lib/constants/messages/en.ts', 'src/lib/constants/messages/it.ts'];
const PAGE_PATHS = ['src/routes/+page.svelte'];

type Driver = ReturnType<typeof createDriver>;

/** Takes a fresh task from request to `ready` with the given predicted paths. */
const toReady = (driver: Driver, paths: readonly string[], userVisible = false): Task => {
  let task = newTask('t1', owner.id);
  task = driver.step(task, { type: 'submit_request' }, asMember(owner));
  task = driver.step(task, { type: 'accept' }, asMember(owner));
  task = driver.step(
    task,
    { type: 'post_spec', predictedPaths: paths, userVisible },
    asAgent('spec')
  );
  task = driver.step(task, { type: 'plan_approval', userVisible, plan: PLAN }, asAgent('chooser'));
  return driver.step(task, { type: 'approve' }, asMember(owner));
};

const buildAndReview = (driver: Driver, task: Task, headSha: string, paths: readonly string[]) => {
  let next = driver.step(
    task,
    { type: 'push', headSha, changedPaths: paths, addedPaths: [], catalogPages: {}, diffLines: 40 },
    asAgent('builder')
  );
  next = driver.step(
    next,
    { type: 'review', verdict: 'approve', notes: '' },
    asAgent('reviewer_spec')
  );
  return driver.step(
    next,
    { type: 'review', verdict: 'approve', notes: '' },
    asAgent('reviewer_correctness')
  );
};

const dispatchAgent = (driver: Driver, task: Task, openInLane = 0): Task =>
  driver.step(
    task,
    {
      type: 'dispatch',
      assignee: { kind: 'agent', role: 'builder' },
      openInLane
    },
    engine
  );

describe('solo owner', () => {
  test('takes a copy change from request to done alone', () => {
    const driver = createDriver([owner]);
    let task = toReady(driver, COPY_PATHS, true);
    expect(task.stage).toBe('ready');
    expect(task.lane).toBe('green');

    task = dispatchAgent(driver, task);
    task = buildAndReview(driver, task, 'abc', COPY_PATHS);
    expect(task.stage).toBe('choosing');

    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('merging');

    task = driver.step(task, { type: 'merged' }, engine);
    expect(task.stage).toBe('done');
  });

  test('records which requirements were waived because nobody can meet them', () => {
    const driver = createDriver([owner]);
    toReady(driver, COPY_PATHS);
    const recorded = driver.events().find((event) => event.type === 'approval_recorded');
    expect(recorded).toMatchObject({ satisfied: true, waived: [{ domain: 'product' }] });
  });
});

describe('collaboration', () => {
  test('a user-visible change also needs the product approver once one exists', () => {
    const driver = createDriver([owner, productContributor]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    task = buildAndReview(driver, task, 'abc', PAGE_PATHS);
    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));

    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('verifying');
    task = driver.step(task, { type: 'approve' }, asMember(productContributor));
    expect(task.stage).toBe('merging');
  });

  test('approvals on an older commit do not carry over after a fix round', () => {
    const driver = createDriver([owner, productContributor]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS, true));
    task = buildAndReview(driver, task, 'abc', PAGE_PATHS);
    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'request_changes', note: 'button too small' },
      asMember(productContributor)
    );
    expect(task.stage).toBe('building');

    task = buildAndReview(driver, task, 'def', PAGE_PATHS);
    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));
    task = driver.step(task, { type: 'approve' }, asMember(productContributor));
    expect(task.stage).toBe('verifying');
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('merging');
  });

  test('an agent cannot mark a change as not user-visible, a maintainer can', () => {
    const driver = createDriver([owner]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS, true));
    task = buildAndReview(driver, task, 'abc', PAGE_PATHS);
    const byAgent = driver.attempt(
      task,
      { type: 'choose', userVisible: false, plan: PLAN },
      asAgent('chooser')
    );
    expect(byAgent.ok && byAgent.task.userVisible).toBe(true);
    const byOwner = driver.attempt(
      task,
      { type: 'choose', userVisible: false, plan: PLAN },
      asMember(owner)
    );
    expect(byOwner.ok && byOwner.task.userVisible).toBe(false);
  });

  test('a member can take a task over from the agent and hand it back', () => {
    const driver = createDriver([owner]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    task = driver.step(task, { type: 'claim' }, asMember(owner));
    expect(task.assignee).toEqual({ kind: 'member', memberId: 'antonio' });
    expect(
      driver.attempt(
        task,
        {
          type: 'push',
          headSha: 'x',
          changedPaths: PAGE_PATHS,
          addedPaths: [],
          catalogPages: {},
          diffLines: 1
        },
        asAgent('builder')
      ).ok
    ).toBe(false);
    task = driver.step(task, { type: 'release' }, asMember(owner));
    expect(task).toMatchObject({ stage: 'ready', assignee: null });
  });
});

describe('guardrails', () => {
  test('an agent that touches red paths is stopped and the owner is asked', () => {
    const driver = createDriver([owner]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    task = driver.step(
      task,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: ['src/satellite/index.ts'],
        addedPaths: [],
        catalogPages: {},
        diffLines: 10
      },
      asAgent('builder')
    );
    expect(task).toMatchObject({ stage: 'ready', lane: 'red', assignee: null });
    expect(task.blocked?.askedOf).toEqual({ role: 'owner' });
    expect(driver.events().some((event) => event.type === 'guardrail_tripped')).toBe(true);

    expect(driver.attempt(task, { type: 'claim' }, asMember(owner))).toEqual({
      ok: false,
      error: 'blocked'
    });
    task = driver.step(task, { type: 'answer', text: 'I will do it' }, asMember(owner));
    const redispatch = driver.attempt(
      task,
      {
        type: 'dispatch',
        assignee: { kind: 'agent', role: 'builder' },
        openInLane: 0
      },
      engine
    );
    expect(redispatch).toEqual({ ok: false, error: 'agents_cannot_build_lane' });
    task = driver.step(task, { type: 'claim' }, asMember(owner));
    expect(task.stage).toBe('building');
  });

  test('a lane never goes down when the spec is revised', () => {
    const driver = createDriver([owner]);
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    task = driver.step(task, { type: 'request_changes', note: 'only copy' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: COPY_PATHS, userVisible: false },
      asAgent('spec')
    );
    expect(task).toMatchObject({ lane: 'standard', specVersion: 2 });
  });

  test('an oversized change is blocked for a maintainer', () => {
    const driver = createDriver([owner]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    task = driver.step(
      task,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: PAGE_PATHS,
        addedPaths: [],
        catalogPages: {},
        diffLines: 5000
      },
      asAgent('builder')
    );
    expect(task.stage).toBe('building');
    expect(task.blocked?.askedOf).toEqual({ role: 'maintainer' });
  });

  test('agent dispatch respects the lane WIP limit, a member claim does not', () => {
    const driver = createDriver([owner]);
    const task = toReady(driver, PAGE_PATHS);
    expect(
      driver.attempt(
        task,
        {
          type: 'dispatch',
          assignee: { kind: 'agent', role: 'builder' },
          openInLane: 3
        },
        engine
      )
    ).toEqual({ ok: false, error: 'wip_limit' });
    expect(driver.attempt(task, { type: 'claim' }, asMember(owner)).ok).toBe(true);
  });

  test('fix rounds are bounded, then a maintainer decides', () => {
    const driver = createDriver([owner]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    for (const sha of ['a', 'b']) {
      task = driver.step(
        task,
        {
          type: 'push',
          headSha: sha,
          changedPaths: PAGE_PATHS,
          addedPaths: [],
          catalogPages: {},
          diffLines: 5
        },
        asAgent('builder')
      );
      task = driver.step(
        task,
        { type: 'review', verdict: 'changes', notes: 'no' },
        asAgent('reviewer_correctness')
      );
      expect(task.stage).toBe('building');
    }
    task = driver.step(
      task,
      {
        type: 'push',
        headSha: 'c',
        changedPaths: PAGE_PATHS,
        addedPaths: [],
        catalogPages: {},
        diffLines: 5
      },
      asAgent('builder')
    );
    task = driver.step(
      task,
      { type: 'review', verdict: 'changes', notes: 'no' },
      asAgent('reviewer_correctness')
    );
    expect(task).toMatchObject({ stage: 'ready', assignee: null, fixRounds: 0 });
    expect(task.blocked?.askedOf).toEqual({ role: 'maintainer' });
  });
});

describe('permissions', () => {
  test('agents never approve, watchers cannot approve, contributors cannot triage', () => {
    const driver = createDriver([owner, productContributor, watcher]);
    let task = newTask('t1', productContributor.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(productContributor));
    expect(driver.attempt(task, { type: 'accept' }, asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    expect(driver.attempt(task, { type: 'approve' }, asAgent('reviewer_spec'))).toEqual({
      ok: false,
      error: 'agents_cannot_approve'
    });
    expect(driver.attempt(task, { type: 'approve' }, asMember(watcher))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
  });

  test('only the person or role asked can answer a question, owners always can', () => {
    const driver = createDriver([owner, productContributor]);
    let task = newTask('t1', owner.id);
    task = driver.step(
      task,
      { type: 'block', question: 'Which locale?', askedOf: { role: 'maintainer' } },
      asAgent('interviewer')
    );
    expect(
      driver.attempt(task, { type: 'answer', text: 'it' }, asMember(productContributor))
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(driver.attempt(task, { type: 'approve' }, asMember(owner))).toEqual({
      ok: false,
      error: 'blocked'
    });
    task = driver.step(task, { type: 'answer', text: 'it' }, asMember(owner));
    expect(task.blocked).toBeNull();
  });

  test('a question keeps the options it offers, and an empty list is no options', () => {
    const driver = createDriver([owner]);
    const options = [{ label: 'Keep it' }, { label: 'Rename it' }];
    const asked = driver.step(
      newTask('t1', owner.id),
      { type: 'block', question: 'Which?', askedOf: { memberId: owner.id }, options },
      asAgent('interviewer')
    );
    expect(asked.blocked).toEqual({ question: 'Which?', askedOf: { memberId: owner.id }, options });
    const plain = driver.step(
      newTask('t2', owner.id),
      { type: 'block', question: 'Which?', askedOf: { memberId: owner.id }, options: [] },
      asAgent('interviewer')
    );
    expect(plain.blocked).toEqual({ question: 'Which?', askedOf: { memberId: owner.id } });
  });

  test('submitting a request as is closes an open interview question', () => {
    const driver = createDriver([owner]);
    let task = newTask('t1', owner.id);
    task = driver.step(
      task,
      { type: 'block', question: 'Which screens?', askedOf: { memberId: owner.id } },
      asAgent('interviewer')
    );
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    expect(task).toMatchObject({ stage: 'triage', blocked: null });
    expect(driver.events()).toContainEqual({ type: 'unblocked', answer: '(submitted as is)' });
  });

  test('the interviewer may submit a request, other agents may not', () => {
    const driver = createDriver([owner]);
    const task = newTask('t1', owner.id);
    expect(driver.step(task, { type: 'submit_request' }, asAgent('interviewer')).stage).toBe(
      'triage'
    );
    expect(driver.attempt(task, { type: 'submit_request' }, asAgent('spec'))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
  });

  test('the requester can cancel their own request and closed tasks accept nothing', () => {
    const driver = createDriver([owner, productContributor]);
    let task = newTask('t1', productContributor.id);
    task = driver.step(
      task,
      { type: 'cancel', reason: 'not needed' },
      asMember(productContributor)
    );
    expect(task.stage).toBe('cancelled');
    expect(driver.attempt(task, { type: 'accept' }, asMember(owner))).toEqual({
      ok: false,
      error: 'terminal'
    });
  });

  test("only a maintainer declines a request, and a contributor cannot cancel someone else's", () => {
    const driver = createDriver([owner, productContributor]);
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    for (const type of ['decline', 'cancel'] as const)
      expect(
        driver.attempt(task, { type, reason: 'not needed' }, asMember(productContributor))
      ).toEqual({ ok: false, error: 'not_allowed' });

    const declined = driver.step(
      task,
      { type: 'decline', reason: 'out of scope' },
      asMember(owner)
    );
    expect(declined.stage).toBe('declined');
    expect(driver.events()).toContainEqual({
      type: 'closed',
      stage: 'declined',
      reason: 'out of scope'
    });

    let theirs = newTask('t2', productContributor.id);
    theirs = driver.step(theirs, { type: 'submit_request' }, asMember(productContributor));
    expect(
      driver.step(theirs, { type: 'cancel', reason: 'duplicate' }, asMember(owner)).stage
    ).toBe('cancelled');
  });

  test('a watcher cannot send a spec or a result back, a contributor only where the policy names them', () => {
    const driver = createDriver([owner, productContributor, watcher]);
    const specReview = driver.step(
      driver.step(
        driver.step(newTask('t1', owner.id), { type: 'submit_request' }, asMember(owner)),
        { type: 'accept' },
        asMember(owner)
      ),
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    let verifying = dispatchAgent(driver, toReady(driver, PAGE_PATHS, true));
    verifying = buildAndReview(driver, verifying, 'abc', PAGE_PATHS);
    verifying = driver.step(
      verifying,
      { type: 'choose', userVisible: true, plan: PLAN },
      asAgent('chooser')
    );
    expect(verifying.stage).toBe('verifying');

    for (const task of [specReview, verifying])
      expect(
        driver.attempt(task, { type: 'request_changes', note: 'no' }, asMember(watcher))
      ).toEqual({ ok: false, error: 'not_allowed' });
    // The standard lane's plan approval names only the owner; its user-visible result, product.
    expect(
      driver.attempt(
        specReview,
        { type: 'request_changes', note: 'name it Preferences' },
        asMember(productContributor)
      )
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(
      driver.step(
        verifying,
        { type: 'request_changes', note: 'name it Preferences' },
        asMember(productContributor)
      ).stage
    ).toBe('building');
    expect(
      driver.step(specReview, { type: 'request_changes', note: 'no' }, asMember(owner)).stage
    ).toBe('speccing');
  });

  test('only the assignee or a maintainer hands a claimed task back', () => {
    const maintainer: Member = { id: 'marta', role: 'maintainer', domains: [] };
    const driver = createDriver([owner, maintainer, productContributor]);
    const claimed = driver.step(
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      { type: 'claim' },
      asMember(maintainer)
    );
    expect(driver.attempt(claimed, { type: 'release' }, asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.step(claimed, { type: 'release' }, asMember(owner))).toMatchObject({
      stage: 'ready',
      assignee: null
    });

    // An assignee whose role was lowered since the claim can still hand it back.
    const lowered = createDriver([owner, { ...maintainer, role: 'contributor' }]);
    expect(lowered.step(claimed, { type: 'release' }, asMember(maintainer))).toMatchObject({
      stage: 'ready',
      assignee: null
    });
  });

  test('only a maintainer pauses or resumes a task, and a paused task takes no decision', () => {
    const driver = createDriver([owner, productContributor]);
    const ready = toReady(driver, PAGE_PATHS);
    expect(driver.attempt(ready, { type: 'pause' }, asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    const paused = driver.step(ready, { type: 'pause' }, asMember(owner));
    expect(paused.paused).toBe(true);
    expect(driver.events()).toEqual([{ type: 'paused' }]);
    expect(driver.attempt(paused, { type: 'pause' }, asMember(owner))).toEqual({
      ok: false,
      error: 'already_paused'
    });
    expect(
      driver.attempt(
        paused,
        { type: 'dispatch', assignee: { kind: 'agent', role: 'builder' }, openInLane: 0 },
        engine
      )
    ).toEqual({ ok: false, error: 'paused' });

    expect(driver.attempt(paused, { type: 'resume' }, asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    const resumed = driver.step(paused, { type: 'resume' }, asMember(owner));
    expect(resumed.paused).toBe(false);
    expect(driver.events()).toEqual([{ type: 'resumed' }]);
    expect(driver.attempt(resumed, { type: 'resume' }, asMember(owner))).toEqual({
      ok: false,
      error: 'not_paused'
    });
    expect(dispatchAgent(driver, resumed).stage).toBe('building');
  });

  test('the engine dispatches a build only to a member who can build', () => {
    const driver = createDriver([owner, productContributor]);
    const task = toReady(driver, PAGE_PATHS);
    const dispatchTo = (memberId: string) =>
      ({
        type: 'dispatch',
        assignee: { kind: 'member', memberId },
        openInLane: 0
      }) as const;
    expect(driver.attempt(task, dispatchTo(productContributor.id), engine)).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.attempt(task, dispatchTo('nobody'), engine)).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.step(task, dispatchTo(owner.id), engine)).toMatchObject({
      stage: 'building',
      assignee: { kind: 'member', memberId: owner.id }
    });
  });

  test('a review is recorded only from a reviewer agent or a member who can steer', () => {
    const driver = createDriver([owner, productContributor]);
    const task = driver.step(
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: PAGE_PATHS,
        addedPaths: [],
        catalogPages: {},
        diffLines: 40
      },
      asAgent('builder')
    );
    expect(task.stage).toBe('reviewing');
    const review = { type: 'review', verdict: 'changes', notes: 'Rename it.' } as const;
    expect(driver.attempt(task, review, asAgent('builder'))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.attempt(task, review, asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    const byOwner = driver.attempt(task, review, asMember(owner));
    expect(byOwner.ok && byOwner.events).toContainEqual({
      type: 'review_recorded',
      reviewer: 'member',
      verdict: 'changes',
      notes: 'Rename it.'
    });
  });
});

describe('approval chooser', () => {
  const toSpecReview = (driver: Driver, paths = PAGE_PATHS, userVisible = false): Task => {
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    return driver.step(
      task,
      { type: 'post_spec', predictedPaths: paths, userVisible },
      asAgent('spec')
    );
  };

  test('nobody approves a spec version before the chooser has planned it', () => {
    const driver = createDriver([owner]);
    let task = toSpecReview(driver);
    expect(nextAgentRoles(task)).toEqual(['chooser']);
    expect(driver.attempt(task, { type: 'approve' }, asMember(owner))).toEqual({
      ok: false,
      error: 'not_planned'
    });
    task = driver.step(
      task,
      { type: 'plan_approval', userVisible: false, plan: PLAN },
      asAgent('chooser')
    );
    expect(nextAgentRoles(task)).toEqual([]);
    expect(driver.step(task, { type: 'approve' }, asMember(owner)).stage).toBe('ready');
  });

  test('an added domain approval must be met by someone who holds it', () => {
    const driver = createDriver([owner, productContributor]);
    let task = toSpecReview(driver);
    task = driver.step(
      task,
      {
        type: 'plan_approval',
        userVisible: false,
        plan: {
          ...PLAN,
          extra: [{ requirement: { domain: 'product' }, reason: 'Changes pricing copy.' }]
        }
      },
      asAgent('chooser')
    );
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('spec_review');
    expect(driver.events()).toContainEqual(
      expect.objectContaining({ type: 'approval_recorded', pending: [{ domain: 'product' }] })
    );
    expect(driver.step(task, { type: 'approve' }, asMember(productContributor)).stage).toBe(
      'ready'
    );
  });

  test('a domain nobody holds is waived, never a dead end', () => {
    const driver = createDriver([owner]);
    let task = driver.step(newTask('t1', owner.id), { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    task = driver.step(
      task,
      {
        type: 'plan_approval',
        userVisible: false,
        plan: { ...PLAN, extra: [{ requirement: { domain: 'legal' }, reason: 'Terms text.' }] }
      },
      asAgent('chooser')
    );
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('ready');
    expect(driver.events()).toContainEqual(
      expect.objectContaining({ type: 'approval_recorded', waived: [{ domain: 'legal' }] })
    );
  });

  test('plans only ever add: a later plan cannot drop an earlier requirement', () => {
    const driver = createDriver([owner, productContributor]);
    let task = toSpecReview(driver);
    const legal = { requirement: { domain: 'legal' }, reason: 'Terms text.' };
    task = driver.step(
      task,
      { type: 'plan_approval', userVisible: false, plan: { ...PLAN, extra: [legal] } },
      asAgent('chooser')
    );
    task = driver.step(task, { type: 'request_changes', note: 'shorter' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    expect(nextAgentRoles(task)).toEqual(['chooser']);
    task = driver.step(
      task,
      {
        type: 'plan_approval',
        userVisible: false,
        plan: {
          ...PLAN,
          verifiers: [
            { memberId: productContributor.id, reason: 'Owns pricing.' },
            { memberId: 'stranger', reason: 'Not a member.' }
          ]
        }
      },
      asAgent('chooser')
    );
    expect(task.approvalPlans.spec_review).toMatchObject({
      subject: 'spec:2',
      extra: [legal],
      verifiers: [{ memberId: productContributor.id, reason: 'Owns pricing.' }]
    });
    expect(effectivePolicy(driver.config, task, 'spec_review')).toContainEqual({ domain: 'legal' });
  });

  test('only the chooser or the engine plans approvals', () => {
    const driver = createDriver([owner]);
    const task = toSpecReview(driver);
    expect(
      driver.attempt(
        task,
        { type: 'plan_approval', userVisible: false, plan: PLAN },
        asMember(owner)
      )
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(
      driver.attempt(
        task,
        { type: 'plan_approval', userVisible: false, plan: PLAN },
        asAgent('spec')
      )
    ).toEqual({ ok: false, error: 'not_allowed' });
  });
});

describe('auto-verify', () => {
  const autoConfig = (onMerge: string) =>
    loadConfig(
      CONFIG_YAML.replace('version: 1', `version: 1\nrelease: { on_merge: ${onMerge} }`).replace(
        '  green:\n',
        '  green:\n    auto_verify: true\n'
      )
    );
  const GLANCE: PlanInput = { ...PLAN, depth: 'glance' };

  const toChoosing = (driver: Driver, paths = COPY_PATHS) =>
    buildAndReview(driver, dispatchAgent(driver, toReady(driver, paths, true)), 'abc', paths);

  test('a green result goes straight to merge when a merge only reaches staging', () => {
    const driver = createDriver([owner], autoConfig('staging'));
    let task = toChoosing(driver);
    task = driver.step(
      task,
      { type: 'choose', userVisible: true, plan: GLANCE },
      asAgent('chooser')
    );
    expect(task.stage).toBe('merging');
    expect(driver.events()).toContainEqual({ type: 'auto_verified', subject: 'sha:abc' });
  });

  test('people still verify when a merge deploys to production', () => {
    const driver = createDriver([owner], autoConfig('production'));
    let task = toChoosing(driver);
    task = driver.step(
      task,
      { type: 'choose', userVisible: true, plan: GLANCE },
      asAgent('chooser')
    );
    expect(task.stage).toBe('verifying');
  });

  test('the chooser keeps the human check by asking for more than a glance or an approval', () => {
    const driver = createDriver([owner], autoConfig('nothing'));
    const deeper = driver.step(
      toChoosing(driver),
      { type: 'choose', userVisible: true, plan: PLAN },
      asAgent('chooser')
    );
    expect(deeper.stage).toBe('verifying');

    const other = createDriver([owner], autoConfig('nothing'));
    const added = other.step(
      toChoosing(other),
      {
        type: 'choose',
        userVisible: true,
        plan: { ...GLANCE, extra: [{ requirement: { role: 'owner' }, reason: 'Pricing copy.' }] }
      },
      asAgent('chooser')
    );
    expect(added.stage).toBe('verifying');
  });

  test('a standard change is always verified by people', () => {
    const driver = createDriver([owner], autoConfig('nothing'));
    const task = driver.step(
      toChoosing(driver, PAGE_PATHS),
      { type: 'choose', userVisible: true, plan: GLANCE },
      asAgent('chooser')
    );
    expect(task.stage).toBe('verifying');
  });
});

describe('who merges', () => {
  test('the chooser decides per result, and a later plan cannot hand the merge back', () => {
    const driver = createDriver([owner]);
    let task = driver.step(newTask('t1', owner.id), { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    task = driver.step(
      task,
      { type: 'plan_approval', userVisible: false, plan: { ...PLAN, merge: 'auto' } },
      asAgent('chooser')
    );
    // The spec gate has nothing to merge.
    expect(task.approvalPlans.spec_review?.merge).toBe('person');

    const choosing = () =>
      buildAndReview(driver, dispatchAgent(driver, toReady(driver, PAGE_PATHS)), 'abc', PAGE_PATHS);
    const auto = driver.step(
      choosing(),
      { type: 'choose', userVisible: true, plan: { ...PLAN, merge: 'auto' } },
      asAgent('chooser')
    );
    expect(auto.approvalPlans.verifying?.merge).toBe('auto');

    task = driver.step(
      choosing(),
      { type: 'choose', userVisible: true, plan: { ...PLAN, merge: 'person' } },
      asAgent('chooser')
    );
    task = driver.step(task, { type: 'request_changes', note: 'wrong colour' }, asMember(owner));
    task = buildAndReview(driver, task, 'def', PAGE_PATHS);
    task = driver.step(
      task,
      { type: 'choose', userVisible: true, plan: { ...PLAN, merge: 'auto' } },
      asAgent('chooser')
    );
    expect(task.approvalPlans.verifying).toMatchObject({ subject: 'sha:def', merge: 'person' });
    // A plan recorded before the choice existed has no `merge`, which counts as a person.
    const legacy = driver.step(
      choosing(),
      { type: 'choose', userVisible: true, plan: PLAN },
      asAgent('chooser')
    );
    const { merge: _dropped, ...older } = legacy.approvalPlans.verifying!;
    let migrated: Task = {
      ...legacy,
      approvalPlans: { ...legacy.approvalPlans, verifying: older }
    };
    migrated = driver.step(migrated, { type: 'request_changes', note: 'again' }, asMember(owner));
    migrated = buildAndReview(driver, migrated, 'ghi', PAGE_PATHS);
    migrated = driver.step(
      migrated,
      { type: 'choose', userVisible: true, plan: { ...PLAN, merge: 'auto' } },
      asAgent('chooser')
    );
    expect(migrated.approvalPlans.verifying?.merge).toBe('person');
  });
});

describe('reviews on GitHub', () => {
  const review = (headSha: string) =>
    ({
      type: 'github_review',
      headSha,
      by: 'copilot-pull-request-reviewer[bot]',
      source: { reviewId: 7 },
      notes: 'Rename the key.',
      overviewOnly: false
    }) as const;

  test('a review of the current head sends the work back to the builder', () => {
    const driver = createDriver([owner]);
    let task = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));
    task = driver.step(task, review('abc'), engine);
    expect(task).toMatchObject({ stage: 'building', fixRounds: 1 });
    expect(driver.events()[0]).toMatchObject({
      type: 'review_recorded',
      reviewer: 'github',
      verdict: 'changes',
      githubReviewId: 7
    });
  });

  test('a review of an earlier head, or from anyone but the engine, changes nothing', () => {
    const driver = createDriver([owner]);
    const task = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    expect(driver.attempt(task, review('old'), engine)).toEqual({ ok: false, error: 'stale_head' });
    expect(driver.attempt(task, review('abc'), asMember(owner))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
  });

  test('a fix round that finds nothing to change keeps the head and goes back to review', () => {
    const driver = createDriver([owner]);
    let task = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));
    task = driver.step(task, review('abc'), engine);
    expect(driver.attempt(task, { type: 'unchanged', note: 'Nothing applies.' }, engine)).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    task = driver.step(task, { type: 'unchanged', note: 'Nothing applies.' }, asAgent('builder'));
    expect(task).toMatchObject({ stage: 'reviewing', headSha: 'abc', reviews: {} });
    expect(driver.events()[0]).toEqual({
      type: 'build_unchanged',
      headSha: 'abc',
      note: 'Nothing applies.'
    });
  });

  test('a first round cannot finish unchanged, since it has built nothing', () => {
    const driver = createDriver([owner]);
    const task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    expect(
      driver.attempt(task, { type: 'unchanged', note: 'Nothing to do.' }, asAgent('builder'))
    ).toEqual({ ok: false, error: 'wrong_stage' });
  });

  test("a bot's comment on the pull request is recorded as a comment, not a review", () => {
    const driver = createDriver([owner]);
    const task = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    driver.step(task, { ...review('abc'), source: { commentId: 31 }, overviewOnly: true }, engine);
    expect(driver.events()[0]).toMatchObject({ githubCommentId: 31, overviewOnly: true });
    expect(driver.events()[0]).not.toHaveProperty('githubReviewId');
  });
});

describe('failing checks on GitHub', () => {
  const failed = (headSha: string) =>
    ({ type: 'ci_failed', headSha, details: 'GitHub Actions: failure' }) as const;

  test('send the work back from review, planning and verification, not only from merging', () => {
    const driver = createDriver([owner]);
    const reviewing = driver.step(
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: PAGE_PATHS,
        addedPaths: [],
        catalogPages: {},
        diffLines: 40
      },
      asAgent('builder')
    );
    const choosing = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    const verifying = driver.step(
      choosing,
      { type: 'choose', userVisible: true, plan: PLAN },
      asAgent('chooser')
    );
    for (const task of [reviewing, choosing, verifying]) {
      expect(driver.step(task, failed('abc'), engine)).toMatchObject({
        stage: 'building',
        fixRounds: 1
      });
      expect(driver.events()[0]).toEqual(failed('abc'));
    }
  });

  test('on an earlier head, while building, or from anyone but the engine, change nothing', () => {
    const driver = createDriver([owner]);
    const building = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    expect(driver.attempt(building, failed('abc'), engine)).toEqual({
      ok: false,
      error: 'wrong_stage'
    });
    const choosing = buildAndReview(driver, building, 'abc', PAGE_PATHS);
    expect(driver.attempt(choosing, failed('old'), engine)).toEqual({
      ok: false,
      error: 'stale_head'
    });
    expect(driver.attempt(choosing, failed('abc'), asMember(owner))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
  });
});

describe('pushes from outside Officina', () => {
  const outside = (headSha: string, changedPaths: readonly string[] = PAGE_PATHS) =>
    ({
      type: 'outside_push',
      headSha,
      changedPaths,
      addedPaths: [],
      catalogPages: {},
      diffLines: 50
    }) as const;

  test('a new head is reviewed, planned and verified again, without a fix round', () => {
    const driver = createDriver([owner]);
    let task = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));
    task = driver.step(task, outside('fix1'), engine);
    expect(task).toMatchObject({ stage: 'reviewing', headSha: 'fix1', reviews: {}, fixRounds: 0 });
    expect(driver.events()).toEqual([
      { type: 'stage_changed', from: 'verifying', to: 'building' },
      {
        type: 'pushed',
        headSha: 'fix1',
        changedPaths: PAGE_PATHS,
        diffLines: 50,
        outside: true
      },
      { type: 'stage_changed', from: 'building', to: 'reviewing' }
    ]);
    // Approving needs a plan for the new head, so nothing verified for the old one carries over.
    task = driver.step(
      task,
      { type: 'review', verdict: 'approve', notes: '' },
      asAgent('reviewer_spec')
    );
    task = driver.step(
      task,
      { type: 'review', verdict: 'approve', notes: '' },
      asAgent('reviewer_correctness')
    );
    expect(task.approvalPlans.verifying?.subject).toBe('sha:abc');
    expect(
      driver.attempt({ ...task, stage: 'verifying' }, { type: 'approve' }, asMember(owner))
    ).toEqual({ ok: false, error: 'not_planned' });
  });

  test('a head that reaches paths agents may not change holds the task for the owner', () => {
    const driver = createDriver([owner]);
    const task = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    const held = driver.step(
      task,
      outside('bot1', [...PAGE_PATHS, '.github/workflows/ci.yml']),
      engine
    );
    expect(held).toMatchObject({ stage: 'ready', lane: 'red', assignee: null });
    expect(held.blocked?.question).toContain('.github/workflows/ci.yml');
  });

  test('the head Officina already holds, a build in progress, or anyone but the engine, change nothing', () => {
    const driver = createDriver([owner]);
    const building = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    expect(driver.attempt(building, outside('abc'), engine)).toEqual({
      ok: false,
      error: 'wrong_stage'
    });
    const choosing = buildAndReview(driver, building, 'abc', PAGE_PATHS);
    expect(driver.attempt(choosing, outside('abc'), engine)).toEqual({
      ok: false,
      error: 'stale_head'
    });
    expect(driver.attempt(choosing, outside('fix1'), asAgent('builder'))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
  });
});

describe('onboarding', () => {
  const onboardingAt = (stage: Task['stage']): Task => ({
    ...newTask('t9', owner.id, 'onboarding'),
    stage,
    lane: 'standard',
    specVersion: 1
  });
  const dispatch = (role: 'builder' | 'onboarder') => ({
    type: 'dispatch' as const,
    assignee: { kind: 'agent' as const, role },
    openInLane: 0
  });
  /** A driver for a project whose onboarding task is still open. */
  const gated = () => createDriver([owner], loadConfig(), { onboardingOpen: true });

  test('no request is dispatched while the project has an open onboarding task', () => {
    const driver = gated();
    const task = toReady(driver, PAGE_PATHS);
    expect(driver.attempt(task, dispatch('builder'), engine)).toEqual({
      ok: false,
      error: 'awaiting_onboarding'
    });
    expect(createDriver([owner]).step(task, dispatch('builder'), engine).stage).toBe('building');
    // People still decide: a maintainer can claim the work by hand.
    expect(driver.step(task, { type: 'claim' }, asMember(owner)).stage).toBe('building');
  });

  test('the onboarding task goes to the onboarder, never to the builder', () => {
    const driver = gated();
    const task = onboardingAt('ready');
    expect(driver.attempt(task, dispatch('builder'), engine)).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    const building = driver.step(task, dispatch('onboarder'), engine);
    expect(nextAgentRoles(building)).toEqual(['onboarder']);
    expect(
      driver.attempt(
        building,
        {
          type: 'push',
          headSha: 'abc',
          changedPaths: ['AGENTS.md'],
          addedPaths: [],
          catalogPages: {},
          diffLines: 10
        },
        asAgent('builder')
      )
    ).toEqual({ ok: false, error: 'not_allowed' });
  });

  test('the gate never holds the onboarding task itself, from dispatch to merge', () => {
    const driver = gated();
    const docs = ['AGENTS.md', 'docs/ai/README.md'];
    let task = driver.step(onboardingAt('ready'), dispatch('onboarder'), engine);
    task = driver.step(
      task,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: docs,
        addedPaths: [],
        catalogPages: {},
        diffLines: 120
      },
      asAgent('onboarder')
    );
    for (const role of ['reviewer_spec', 'reviewer_correctness'] as const)
      task = driver.step(task, { type: 'review', verdict: 'approve', notes: '' }, asAgent(role));
    // A review that asks for changes is a fix round for the onboarder, never a new dispatch.
    const fixing = driver.step(
      { ...task, stage: 'reviewing', reviews: {} },
      { type: 'review', verdict: 'changes', notes: 'name the real paths' },
      asAgent('reviewer_correctness')
    );
    expect(fixing).toMatchObject({ stage: 'building', assignee: { role: 'onboarder' } });
    expect(nextAgentRoles(fixing)).toEqual(['onboarder']);
    task = driver.step(
      task,
      { type: 'choose', userVisible: false, plan: PLAN },
      asAgent('chooser')
    );
    expect(task.stage).toBe('verifying');
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('merging');
    task = driver.step(task, { type: 'merged' }, engine);
    expect(task.stage).toBe('done');
  });

  test('a pull request closed without a merge sends the task back, held for a maintainer', () => {
    const driver = gated();
    const building = driver.step(onboardingAt('ready'), dispatch('onboarder'), engine);
    // Before the first push there is no pull request to close.
    expect(
      driver.attempt(building, { type: 'pull_request_closed', pullRequest: 7 }, engine)
    ).toEqual({ ok: false, error: 'wrong_stage' });
    const reviewing = driver.step(
      building,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: ['AGENTS.md'],
        addedPaths: [],
        catalogPages: {},
        diffLines: 10
      },
      asAgent('onboarder')
    );
    expect(
      driver.attempt(reviewing, { type: 'pull_request_closed', pullRequest: 7 }, asMember(owner))
    ).toEqual({ ok: false, error: 'not_allowed' });
    const held = driver.step(reviewing, { type: 'pull_request_closed', pullRequest: 7 }, engine);
    expect(held).toMatchObject({ stage: 'ready', assignee: null, headSha: null, fixRounds: 0 });
    expect(held.blocked?.question).toContain('#7');
    expect(held.blocked?.askedOf).toEqual({ role: 'maintainer' });
    expect(driver.events()).toContainEqual({ type: 'pull_request_closed', pullRequest: 7 });
    // Answering lets the engine dispatch it again as a first round; cancelling lifts the gate.
    const answered = driver.step(held, { type: 'answer', text: 'build it again' }, asMember(owner));
    expect(driver.step(answered, dispatch('onboarder'), engine).stage).toBe('building');
    expect(driver.step(held, { type: 'cancel', reason: 'not now' }, asMember(owner)).stage).toBe(
      'cancelled'
    );
  });

  test('the engine may close an onboarding task whose pages exist, never a request', () => {
    const driver = gated();
    const reason = 'every required agent docs page is on the default branch already';
    expect(driver.step(onboardingAt('ready'), { type: 'cancel', reason }, engine).stage).toBe(
      'cancelled'
    );
    const request = toReady(driver, PAGE_PATHS);
    expect(driver.attempt(request, { type: 'cancel', reason }, engine)).toEqual({
      ok: false,
      error: 'not_allowed'
    });
  });

  test('the onboarder may change the agent docs and nothing else', () => {
    const driver = gated();
    const building = driver.step(onboardingAt('ready'), dispatch('onboarder'), engine);
    const docs = ['AGENTS.md', 'CLAUDE.md', 'docs/ai/README.md', 'docs/ai/workflows/add-a-page.md'];
    const reviewed = driver.step(
      building,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: docs,
        addedPaths: [],
        catalogPages: {},
        diffLines: 300
      },
      asAgent('onboarder')
    );
    expect(reviewed.stage).toBe('reviewing');

    const stopped = driver.step(
      building,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: [...docs, 'src/app.ts'],
        addedPaths: [],
        catalogPages: {},
        diffLines: 310
      },
      asAgent('onboarder')
    );
    expect(stopped).toMatchObject({ stage: 'ready', assignee: null });
    expect(stopped.blocked?.question).toContain('src/app.ts');
    expect(driver.events()).toContainEqual({
      type: 'guardrail_tripped',
      guardrail: 'outside_agent_docs',
      details: 'src/app.ts'
    });
  });
});

describe('catalog check', () => {
  const withCatalog = loadConfig(
    CONFIG_YAML.replace(
      'docs: { entry: AGENTS.md }',
      "docs: { entry: AGENTS.md, catalogs: { 'src/lib/components/**': reusability.md } }"
    )
  );
  const NEW_COMPONENT = 'src/lib/components/Chip.svelte';

  test('a new shared file the catalog does not name goes back to the builder, head kept', () => {
    const driver = createDriver([owner], withCatalog);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    // The page was edited in the same push, but still says nothing about the new file.
    task = driver.step(
      task,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: [...PAGE_PATHS, NEW_COMPONENT, 'docs/ai/reusability.md'],
        addedPaths: [NEW_COMPONENT],
        catalogPages: { 'docs/ai/reusability.md': '# Reusability\n\n- `$lib/Button.svelte`\n' },
        diffLines: 40
      },
      asAgent('builder')
    );
    expect(task).toMatchObject({ stage: 'building', headSha: 'abc', fixRounds: 1, blocked: null });
    expect(nextAgentRoles(task)).toEqual(['builder']);
    const finding = driver.events().find((event) => event.type === 'guardrail_tripped');
    expect(finding).toMatchObject({ guardrail: 'unlisted_files' });
    expect(JSON.stringify(finding)).toContain('docs/ai/reusability.md');

    task = driver.step(
      task,
      {
        type: 'push',
        headSha: 'def',
        changedPaths: [...PAGE_PATHS, NEW_COMPONENT, 'docs/ai/reusability.md'],
        addedPaths: [NEW_COMPONENT],
        catalogPages: {
          'docs/ai/reusability.md': '# Reusability\n\n- `$lib/components/Chip.svelte`: a chip\n'
        },
        diffLines: 44
      },
      asAgent('builder')
    );
    expect(task.stage).toBe('reviewing');
  });

  test('past the fix rounds the finding holds the task for a maintainer', () => {
    const driver = createDriver([owner], withCatalog);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    const push = {
      type: 'push' as const,
      headSha: 'abc',
      changedPaths: [NEW_COMPONENT],
      addedPaths: [NEW_COMPONENT],
      catalogPages: {},
      diffLines: 10
    };
    task = driver.step(task, push, asAgent('builder'));
    task = driver.step(task, push, asAgent('builder'));
    task = driver.step(task, push, asAgent('builder'));
    expect(task).toMatchObject({ stage: 'ready', assignee: null });
    expect(task.blocked?.askedOf).toEqual({ role: 'maintainer' });
  });
});

describe('the requester is not assumed to approve their own task', () => {
  const marco = { id: 'marco', role: 'maintainer', domains: [] } as const;
  const SEPARATE = `${CONFIG_YAML}approvals:\n  self_approval: false\n`;

  const plannedSpec = (driver: Driver): Task => {
    let task = newTask('t1', marco.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(marco));
    task = driver.step(task, { type: 'accept' }, asMember(marco));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: COPY_PATHS, userVisible: false },
      asAgent('spec')
    );
    return driver.step(
      task,
      { type: 'plan_approval', userVisible: false, plan: PLAN },
      asAgent('chooser')
    );
  };

  test('by default a maintainer who asked can also approve the plan', () => {
    const driver = createDriver([owner, marco]);
    const task = driver.step(plannedSpec(driver), { type: 'approve' }, asMember(marco));
    // The green lane needs the requester and a product approver (nobody holds it: waived).
    expect(task.stage).toBe('ready');
  });

  test('with self_approval off, someone else must meet the maintainer floor', () => {
    const driver = createDriver([owner, marco], loadConfig(SEPARATE));
    let task = driver.step(plannedSpec(driver), { type: 'approve' }, asMember(marco));
    expect(task.stage).toBe('spec_review');
    expect(driver.events()).toContainEqual(
      expect.objectContaining({ type: 'approval_recorded', pending: [{ role: 'maintainer' }] })
    );
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('ready');
  });

  test('with self_approval off, a requester alone in the project is never stuck', () => {
    const driver = createDriver([marco], loadConfig(SEPARATE));
    expect(driver.step(plannedSpec(driver), { type: 'approve' }, asMember(marco)).stage).toBe(
      'ready'
    );
  });
});

describe('work agents cannot or should not do goes to a person', () => {
  const developerPlan: PlanInput = {
    ...PLAN,
    build: 'person',
    buildReason: 'A large port of the static design.'
  };

  test('a plan that asks for a developer keeps agents off the build until a maintainer claims it', () => {
    const driver = createDriver([owner, productContributor]);
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    task = driver.step(
      task,
      { type: 'plan_approval', userVisible: false, plan: developerPlan },
      asAgent('chooser')
    );
    // A later plan cannot hand the build back to the agent.
    task = driver.step(
      task,
      { type: 'plan_approval', userVisible: false, plan: PLAN },
      asAgent('chooser')
    );
    expect(task.approvalPlans.spec_review).toMatchObject({
      build: 'person',
      buildReason: 'A large port of the static design.'
    });
    expect(humanBuildReason(driver.config, task)).toBe('A large port of the static design.');
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('ready');

    const agent = { kind: 'agent', role: 'builder' } as const;
    expect(
      driver.attempt(task, { type: 'dispatch', assignee: agent, openInLane: 0 }, engine)
    ).toEqual({ ok: false, error: 'needs_developer' });
    expect(driver.attempt(task, { type: 'claim' }, asMember(productContributor)).ok).toBe(false);
    expect(driver.step(task, { type: 'claim' }, asMember(owner))).toMatchObject({
      stage: 'building',
      assignee: { kind: 'member', memberId: owner.id }
    });
  });

  test('a contributor with the developer domain claims it, but not from another person', () => {
    const dev = { id: 'dev', role: 'contributor', domains: ['developer'] } as const;
    const other = { id: 'other', role: 'contributor', domains: ['developer'] } as const;
    const driver = createDriver([owner, dev, other]);
    let task = toReady(driver, PAGE_PATHS);
    task = driver.step(task, { type: 'claim' }, asMember(dev));
    expect(task).toMatchObject({
      stage: 'building',
      assignee: { kind: 'member', memberId: 'dev' }
    });
    expect(driver.attempt(task, { type: 'claim' }, asMember(other))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.step(task, { type: 'claim' }, asMember(owner)).assignee).toEqual({
      kind: 'member',
      memberId: owner.id
    });
  });

  test('only an agent result hands a task to a person; a member asks an ordinary question', () => {
    const driver = createDriver([owner]);
    const task = newTask('t1', owner.id);
    const handoff = { needs: ['secrets' as const] };
    const byAgent = driver.step(
      task,
      { type: 'block', question: 'Needs a key.', askedOf: { role: 'owner' }, handoff },
      asAgent('interviewer')
    );
    expect(byAgent.blocked).toEqual({
      question: 'Needs a key.',
      askedOf: { role: 'owner' },
      handoff
    });
    const byMember = driver.step(
      task,
      { type: 'block', question: 'Which one?', askedOf: { role: 'owner' }, handoff },
      asMember(owner)
    );
    expect(byMember.blocked).not.toHaveProperty('handoff');
  });
});

describe('guarded tasks', () => {
  const GUARDED = `${CONFIG_YAML}guards:\n  confidential: ['room/**']\n  publishing: ['CNAME']\n`;

  test('a push that adds a secret file never reaches review and goes to the owner', () => {
    const driver = createDriver([owner]);
    const task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    const next = driver.step(
      task,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: ['src/routes/+page.svelte', '.env'],
        addedPaths: ['.env'],
        catalogPages: {},
        diffLines: 10
      },
      asAgent('builder')
    );
    expect(next).toMatchObject({ stage: 'ready', assignee: null });
    expect(next.blocked?.askedOf).toEqual({ role: 'owner' });
    expect(driver.events()).toContainEqual({
      type: 'guardrail_tripped',
      guardrail: 'secret_files',
      details: '.env'
    });
  });

  test('a change that publishes needs the owner, never skips people and never auto-merges', () => {
    const driver = createDriver([owner], loadConfig(GUARDED));
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: ['CNAME', ...COPY_PATHS], userVisible: false },
      asAgent('spec')
    );
    expect(task.guards).toEqual(['publishing']);
    expect(driver.events()).toContainEqual({ type: 'guards_changed', guards: ['publishing'] });
    expect(effectivePolicy(driver.config, task, 'spec_review')).toContainEqual({ role: 'owner' });
    expect(canAutoVerify(driver.config, { ...task, lane: 'green' })).toBe(false);
  });

  test('confidential content is approved only by members who may see it', () => {
    const ceo = { id: 'tim', role: 'contributor', domains: ['product', 'confidential'] } as const;
    const driver = createDriver([owner, productContributor, ceo], loadConfig(GUARDED));
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: ['room/investors.md'], userVisible: true },
      asAgent('spec')
    );
    task = driver.step(
      task,
      {
        type: 'plan_approval',
        userVisible: true,
        plan: { ...PLAN, extra: [{ requirement: { domain: 'product' }, reason: 'Copy.' }] }
      },
      asAgent('chooser')
    );
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    task = driver.step(task, { type: 'approve' }, asMember(productContributor));
    // Gio holds product but may not see confidential content: his approval meets nothing.
    expect(task.stage).toBe('spec_review');
    expect(driver.step(task, { type: 'approve' }, asMember(ceo)).stage).toBe('ready');
  });

  test('nobody claims the build of a confidential task they may not read', () => {
    const dev = { id: 'dev', role: 'contributor', domains: ['developer'] } as const;
    const trusted = {
      id: 'eva',
      role: 'contributor',
      domains: ['developer', 'confidential']
    } as const;
    const driver = createDriver([owner, dev, trusted], loadConfig(GUARDED));
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: ['room/deck.md'], userVisible: false },
      asAgent('spec')
    );
    task = driver.step(
      task,
      { type: 'plan_approval', userVisible: false, plan: PLAN },
      asAgent('chooser')
    );
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(driver.attempt(task, { type: 'claim' }, asMember(dev))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.step(task, { type: 'claim' }, asMember(trusted)).stage).toBe('building');
  });

  test('nobody sends back or answers on a confidential task they may not read', () => {
    const ceo = { id: 'tim', role: 'contributor', domains: ['product', 'confidential'] } as const;
    const driver = createDriver([owner, productContributor, ceo], loadConfig(GUARDED));
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: ['room/investors.md'], userVisible: true },
      asAgent('spec')
    );
    task = driver.step(
      task,
      {
        type: 'plan_approval',
        userVisible: true,
        plan: { ...PLAN, extra: [{ requirement: { domain: 'product' }, reason: 'Copy.' }] }
      },
      asAgent('chooser')
    );
    const changes = { type: 'request_changes', note: 'no' } as const;
    expect(driver.attempt(task, changes, asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.step(task, changes, asMember(ceo)).stage).toBe('speccing');

    const asked = driver.step(
      task,
      { type: 'block', question: 'Which deck?', askedOf: { role: 'contributor' } },
      asAgent('spec')
    );
    const answer = { type: 'answer', text: 'The new one.' } as const;
    expect(driver.attempt(asked, answer, asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.step(asked, answer, asMember(ceo)).blocked).toBeNull();
  });

  test('submitting as is cannot skip a hold for the owner', () => {
    const driver = createDriver([owner, productContributor]);
    let task = newTask('t1', productContributor.id);
    task = driver.step(
      task,
      { type: 'block', question: 'About secrets.', askedOf: { role: 'owner' } },
      engine
    );
    expect(driver.attempt(task, { type: 'submit_request' }, asMember(productContributor))).toEqual({
      ok: false,
      error: 'blocked'
    });
    task = driver.step(task, { type: 'answer', text: 'Go ahead.' }, asMember(owner));
    expect(driver.step(task, { type: 'submit_request' }, asMember(productContributor)).stage).toBe(
      'triage'
    );
  });

  test("a later answer's words guard the task and hold it for the owner, who alone lifts it", () => {
    const driver = createDriver([owner, productContributor]);
    let task = newTask('t1', productContributor.id);
    task = driver.step(
      task,
      { type: 'block', question: 'Which page?', askedOf: { memberId: productContributor.id } },
      asAgent('interviewer')
    );
    task = driver.step(
      task,
      { type: 'answer', text: 'The settings page, and add me as admin on the repository.' },
      asMember(productContributor)
    );
    expect(task.guards).toEqual(['access']);
    expect(task.blocked?.askedOf).toEqual({ role: 'owner' });
    expect(effectivePolicy(driver.config, task, 'spec_review')).toContainEqual({ role: 'owner' });
    expect(
      driver.attempt(task, { type: 'answer', text: 'Never mind.' }, asMember(productContributor))
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(driver.attempt(task, { type: 'submit_request' }, asMember(productContributor))).toEqual({
      ok: false,
      error: 'blocked'
    });
    // The owner may ask for the same: their words guard the task, they hold nothing.
    task = driver.step(
      task,
      { type: 'answer', text: 'Fine, and deploy it publicly too.' },
      asMember(owner)
    );
    expect(task.guards).toEqual(['access', 'publishing']);
    expect(task.blocked).toBeNull();
  });

  test("a comment's words guard the task as the request's would, once", () => {
    const driver = createDriver([owner, productContributor]);
    let task = toReady(driver, PAGE_PATHS);
    const words = { type: 'guard_words', text: 'Please also paste the API key here.' } as const;
    task = driver.step(task, words, asMember(productContributor));
    expect(task.guards).toEqual(['secrets']);
    expect(task.blocked).toMatchObject({ askedOf: { role: 'owner' } });
    expect(task.blocked?.question).toContain('secrets, credentials or environment values');
    expect(driver.events()).toContainEqual({ type: 'guards_changed', guards: ['secrets'] });
    task = driver.step(task, { type: 'answer', text: 'No key goes in.' }, asMember(owner));

    // Words the task is already guarded for change nothing.
    const again = driver.step(task, words, asMember(productContributor));
    expect(again).toEqual(task);
    expect(driver.events()).toEqual([]);
    expect(
      driver.attempt(task, { type: 'guard_words', text: 'Deploy it.' }, asMember(watcher))
    ).toEqual({ ok: false, error: 'not_allowed' });
  });

  test("guarded words replace a question for someone else, never the owner's hold", () => {
    const driver = createDriver([owner, productContributor]);
    const ready = toReady(driver, PAGE_PATHS);
    const asked = driver.step(
      ready,
      { type: 'block', question: 'Which colour?', askedOf: { role: 'contributor' } },
      asAgent('spec')
    );
    const held = driver.step(
      asked,
      { type: 'guard_words', text: 'Make it public tonight.' },
      asMember(productContributor)
    );
    expect(held.blocked?.askedOf).toEqual({ role: 'owner' });
    const ownersQuestion = driver.step(
      ready,
      { type: 'block', question: 'Which host?', askedOf: { role: 'owner' } },
      engine
    );
    const kept = driver.step(
      ownersQuestion,
      { type: 'guard_words', text: 'Make it public tonight.' },
      asMember(productContributor)
    );
    expect(kept.blocked?.question).toBe('Which host?');
    expect(kept.guards).toEqual(['publishing']);
  });

  test('a handoff for a secret, access or publishing guards the task like asking for it', () => {
    const driver = createDriver([owner]);
    const task = driver.step(
      toReady(driver, PAGE_PATHS),
      {
        type: 'block',
        question: 'The deploy needs a token.\n\nNeeded:\n- A deploy token',
        askedOf: { role: 'owner' },
        handoff: { needs: ['secrets', 'publishing', 'dns'] }
      },
      engine
    );
    expect(task.guards).toEqual(['secrets', 'publishing']);
    expect(driver.events()).toContainEqual({
      type: 'guards_changed',
      guards: ['secrets', 'publishing']
    });
    expect(effectivePolicy(driver.config, task, 'verifying')).toContainEqual({ role: 'owner' });
  });
});

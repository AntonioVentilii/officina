import { describe, expect, test } from 'bun:test';
import { effectivePolicy, newTask, nextAgentRoles, type PlanInput, type Task } from '../src';
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
      reviewId: 7,
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

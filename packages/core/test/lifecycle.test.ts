import { describe, expect, test } from 'bun:test';
import { newTask, type Task } from '../src';
import {
  asAgent,
  asMember,
  createDriver,
  engine,
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
  return driver.step(task, { type: 'approve' }, asMember(owner));
};

const buildAndReview = (driver: Driver, task: Task, headSha: string, paths: readonly string[]) => {
  let next = driver.step(
    task,
    { type: 'push', headSha, changedPaths: paths, diffLines: 40 },
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
    { type: 'dispatch', assignee: { kind: 'agent', role: 'builder' }, openInLane },
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

    task = driver.step(task, { type: 'choose', userVisible: true }, asAgent('chooser'));
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
    task = driver.step(task, { type: 'choose', userVisible: true }, asAgent('chooser'));

    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('verifying');
    task = driver.step(task, { type: 'approve' }, asMember(productContributor));
    expect(task.stage).toBe('merging');
  });

  test('approvals on an older commit do not carry over after a fix round', () => {
    const driver = createDriver([owner, productContributor]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS, true));
    task = buildAndReview(driver, task, 'abc', PAGE_PATHS);
    task = driver.step(task, { type: 'choose', userVisible: true }, asAgent('chooser'));
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'request_changes', note: 'button too small' },
      asMember(productContributor)
    );
    expect(task.stage).toBe('building');

    task = buildAndReview(driver, task, 'def', PAGE_PATHS);
    task = driver.step(task, { type: 'choose', userVisible: true }, asAgent('chooser'));
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
      { type: 'choose', userVisible: false },
      asAgent('chooser')
    );
    expect(byAgent.ok && byAgent.task.userVisible).toBe(true);
    const byOwner = driver.attempt(task, { type: 'choose', userVisible: false }, asMember(owner));
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
        { type: 'push', headSha: 'x', changedPaths: PAGE_PATHS, diffLines: 1 },
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
      { type: 'push', headSha: 'abc', changedPaths: ['src/satellite/index.ts'], diffLines: 10 },
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
      { type: 'dispatch', assignee: { kind: 'agent', role: 'builder' }, openInLane: 0 },
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
      { type: 'push', headSha: 'abc', changedPaths: PAGE_PATHS, diffLines: 5000 },
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
        { type: 'dispatch', assignee: { kind: 'agent', role: 'builder' }, openInLane: 3 },
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
        { type: 'push', headSha: sha, changedPaths: PAGE_PATHS, diffLines: 5 },
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
      { type: 'push', headSha: 'c', changedPaths: PAGE_PATHS, diffLines: 5 },
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
    expect(driver.attempt(task, { type: 'submit_request' }, asMember(owner))).toEqual({
      ok: false,
      error: 'blocked'
    });
    task = driver.step(task, { type: 'answer', text: 'it' }, asMember(owner));
    expect(task.blocked).toBeNull();
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

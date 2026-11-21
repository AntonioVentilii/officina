import { describe, expect, test } from 'bun:test';
import {
  RULED_PLAN_RATIONALE,
  nextAgentRoles,
  ruledSpecPlan,
  type Member,
  type Task
} from '../src';
import {
  asAgent,
  asMember,
  createDriver,
  engine,
  newTask,
  owner,
  productContributor
} from './fixtures';

type Driver = ReturnType<typeof createDriver>;

const RED_PATHS = ['src/satellite/main.rs'];
const PAGE_PATHS = ['src/routes/+page.svelte'];
const maintainer: Member = { id: 'marta', role: 'maintainer', domains: [] };

const toSpecReview = (driver: Driver, paths: readonly string[]): Task => {
  let task = newTask('t1', owner.id);
  task = driver.step(task, { type: 'submit_request' }, asMember(owner));
  task = driver.step(task, { type: 'accept' }, asMember(owner));
  return driver.step(
    task,
    { type: 'post_spec', predictedPaths: paths, userVisible: false },
    asAgent('spec')
  );
};

describe('a spec planned by rule', () => {
  test('a red-lane spec the chooser could change nothing about is planned by the engine', () => {
    const members = [owner];
    const driver = createDriver(members);
    let task = toSpecReview(driver, RED_PATHS);
    const plan = ruledSpecPlan(driver.config, task, members);
    expect(plan).toMatchObject({
      rationale: RULED_PLAN_RATIONALE,
      extra: [],
      build: 'person',
      buildReason: 'Agents may not build changes in the red lane.'
    });
    task = driver.step(task, { type: 'plan_approval', userVisible: false, plan: plan! }, engine);
    expect(nextAgentRoles(task)).toEqual([]);
    expect(ruledSpecPlan(driver.config, task, members)).toBeNull();
    expect(driver.step(task, { type: 'approve' }, asMember(owner)).stage).toBe('ready');
  });

  test('a spec an agent may build still waits for the chooser, who decides who builds it', () => {
    const driver = createDriver([owner]);
    const task = toSpecReview(driver, PAGE_PATHS);
    expect(ruledSpecPlan(driver.config, task, [owner])).toBeNull();
    expect(nextAgentRoles(task)).toEqual(['chooser']);
  });

  test('a second maintainer keeps the chooser, who could still ask for the owner', () => {
    const members = [owner, maintainer];
    const driver = createDriver(members);
    expect(ruledSpecPlan(driver.config, toSpecReview(driver, RED_PATHS), members)).toBeNull();
  });

  test('a member with a domain keeps the chooser, who could ask for that domain', () => {
    const members = [owner, productContributor];
    const driver = createDriver(members);
    expect(ruledSpecPlan(driver.config, toSpecReview(driver, RED_PATHS), members)).toBeNull();
  });

  test('a new spec version is planned by rule again, once', () => {
    const members = [owner];
    const driver = createDriver(members);
    let task = toSpecReview(driver, RED_PATHS);
    const plan = ruledSpecPlan(driver.config, task, members)!;
    task = driver.step(task, { type: 'plan_approval', userVisible: false, plan }, engine);
    task = driver.step(task, { type: 'request_changes', note: 'Split it.' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: RED_PATHS, userVisible: false },
      asAgent('spec')
    );
    expect(ruledSpecPlan(driver.config, task, members)).toEqual(plan);
  });
});

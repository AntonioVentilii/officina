import { describe, expect, test } from 'bun:test';
import { handoffCommand, type Member, type Task } from '../src';
import {
  asAgent,
  asMember,
  createDriver,
  engine,
  newTask,
  owner,
  productContributor,
  watcher
} from './fixtures';

const maintainer: Member = { id: 'mara', role: 'maintainer', domains: [] };
const tim: Member = { id: 'tim', role: 'contributor', domains: ['product', 'confidential'] };

/** A request the interviewer handed to the owners for an account, which an owner may hand on. */
const handedOff = (driver: ReturnType<typeof createDriver>): Task =>
  driver.step(
    newTask('t1', owner.id),
    handoffCommand({
      outcome: 'needs_person',
      needs: ['account'],
      why: 'How investors book a call is a product choice.',
      asks: ['Choose how an investor books a call with the founders']
    }),
    asAgent('interviewer')
  );

describe('handing a waiting question to a member', () => {
  test('an owner hands it to one member, who then answers it', () => {
    const driver = createDriver([owner, maintainer, tim]);
    const held = handedOff(driver);

    const handed = driver.step(held, { type: 'hand_question', memberId: tim.id }, asMember(owner));
    expect(handed.blocked).toMatchObject({
      askedOf: { memberId: tim.id },
      handoff: { needs: ['account'] }
    });
    expect(handed.blocked?.question).toBe(held.blocked?.question);
    expect(driver.events()).toEqual([
      { type: 'question_handed', from: { role: 'owner' }, memberId: tim.id }
    ]);

    // Handing it to whoever it already waits on records nothing.
    expect(
      driver.step(handed, { type: 'hand_question', memberId: tim.id }, asMember(owner))
    ).toEqual(handed);
    expect(driver.events()).toEqual([]);

    const answered = driver.step(
      handed,
      { type: 'answer', text: 'A Calendly link on the deck page.' },
      asMember(tim)
    );
    expect(answered.blocked).toBeNull();
  });

  test('handing it to someone already asked of it by role records nothing', () => {
    const driver = createDriver([owner, maintainer, tim]);
    const held = driver.step(
      newTask('t3', owner.id),
      handoffCommand({
        outcome: 'needs_person',
        needs: ['tooling'],
        why: 'The tools cannot do it.',
        asks: ['Run the migration by hand']
      }),
      asAgent('interviewer')
    );
    expect(held.blocked?.askedOf).toEqual({ role: 'maintainer' });
    expect(
      driver.step(held, { type: 'hand_question', memberId: maintainer.id }, asMember(owner))
    ).toEqual(held);
    expect(driver.events()).toEqual([]);
  });

  test('only an owner hands a question on', () => {
    const driver = createDriver([owner, maintainer, tim]);
    const held = handedOff(driver);
    const command = { type: 'hand_question', memberId: tim.id } as const;
    for (const actor of [asMember(maintainer), asMember(tim), asAgent('interviewer'), engine])
      expect(driver.attempt(held, command, actor)).toEqual({ ok: false, error: 'not_allowed' });
  });

  test('the member it goes to must be able to answer it and read the task', () => {
    const driver = createDriver([owner, tim, watcher, productContributor]);
    const held = handedOff(driver);
    const handTo = (task: Task, memberId: string) =>
      driver.attempt(task, { type: 'hand_question', memberId }, asMember(owner));
    const refused = { ok: false, error: 'not_answerer' } as const;
    expect(handTo(held, watcher.id)).toEqual(refused);
    expect(handTo(held, 'nobody')).toEqual(refused);
    // A confidential task goes only to someone who may read it.
    const confidential: Task = { ...held, guards: ['confidential'] };
    expect(handTo(confidential, productContributor.id)).toEqual(refused);
    expect(handTo(confidential, tim.id).ok).toBe(true);
  });

  test('there must be a question, and an early merge stays with whoever decides it', () => {
    const driver = createDriver([owner, tim]);
    const command = { type: 'hand_question', memberId: tim.id } as const;
    expect(driver.attempt(newTask('t2', owner.id), command, asMember(owner))).toEqual({
      ok: false,
      error: 'not_blocked'
    });
    const merged: Task = {
      ...handedOff(driver),
      mergedEarly: { pullRequest: 4, by: null, at: null, stage: 'verifying' }
    };
    expect(driver.attempt(merged, command, asMember(owner))).toEqual({
      ok: false,
      error: 'merged_early'
    });
  });
});

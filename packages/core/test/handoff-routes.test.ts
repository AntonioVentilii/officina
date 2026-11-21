import { describe, expect, test } from 'bun:test';
import {
  canAnswer,
  handoffCommand,
  heldForOwner,
  type HandoffNeed,
  type Member,
  type Task
} from '../src';
import { asAgent, asMember, createDriver, engine, newTask, owner } from './fixtures';

const tim: Member = { id: 'tim', role: 'contributor', domains: ['product', 'confidential'] };
const gio: Member = { id: 'gio', role: 'contributor', domains: ['finance', 'confidential'] };
const mara: Member = { id: 'mara', role: 'maintainer', domains: [] };
const PROJECT = [owner, tim, gio, mara];

/** A request the interviewer handed to a person for these needs. */
const handedOff = (driver: ReturnType<typeof createDriver>, needs: HandoffNeed[], task?: Task) =>
  driver.step(
    task ?? newTask('t1', owner.id),
    handoffCommand({
      outcome: 'needs_person',
      needs,
      why: 'How investors book a call with the founders.',
      asks: ['Choose how they book it', 'Open the booking account']
    }),
    asAgent('interviewer')
  );

const answer = (text: string) => ({ type: 'answer', text }) as const;

describe('who a handoff goes to', () => {
  test('a business or product decision goes to the members who hold product', () => {
    const driver = createDriver(PROJECT);
    const held = handedOff(driver, ['decision']);
    expect(held.blocked).toMatchObject({
      askedOf: { domain: 'product' },
      handoff: { needs: ['decision'] }
    });
    expect(held.blocked?.handoff).not.toHaveProperty('parts');
    const asked = held.blocked!.askedOf;
    expect(canAnswer(tim, asked)).toBe(true);
    // Owners may answer any question; nobody else without the domain may.
    expect(canAnswer(owner, asked)).toBe(true);
    expect(canAnswer(gio, asked)).toBe(false);
    expect(canAnswer(mara, asked)).toBe(false);
    expect(driver.step(held, answer('A Calendly link.'), asMember(tim)).blocked).toBeNull();
  });

  test('an account or access still goes to the owners', () => {
    const driver = createDriver(PROJECT);
    const held = handedOff(driver, ['account', 'access']);
    expect(held.blocked?.askedOf).toEqual({ role: 'owner' });
    expect(driver.attempt(held, answer('Done.'), asMember(tim))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.step(held, answer('Done.'), asMember(owner)).blocked).toBeNull();
  });

  test('a decision with no one to take it goes to the owner', () => {
    const watcherWithProduct: Member = { id: 'w', role: 'watcher', domains: ['product'] };
    const alone = createDriver([owner, gio, watcherWithProduct]);
    expect(handedOff(alone, ['decision']).blocked?.askedOf).toEqual({ role: 'owner' });
    // Nor when the only product holder may not read a confidential task.
    const reader: Member = { id: 'r', role: 'contributor', domains: ['product'] };
    const confidential: Task = { ...newTask('t2', owner.id), guards: ['confidential'] };
    const driver = createDriver([owner, reader]);
    expect(handedOff(driver, ['decision'], confidential).blocked?.askedOf).toEqual({
      role: 'owner'
    });
  });

  test('a task that needs both splits into a part for each, and waits until both are answered', () => {
    const driver = createDriver(PROJECT);
    const held = handedOff(driver, ['decision', 'account']);
    expect(held.blocked).toMatchObject({
      askedOf: { anyOf: [{ role: 'owner' }, { domain: 'product' }] },
      handoff: {
        needs: ['decision', 'account'],
        parts: [
          { askedOf: { role: 'owner' }, needs: ['account'] },
          { askedOf: { domain: 'product' }, needs: ['decision'] }
        ]
      }
    });
    expect(canAnswer(tim, held.blocked!.askedOf)).toBe(true);
    expect(canAnswer(gio, held.blocked!.askedOf)).toBe(false);

    // Tim answers the decision; the account part still waits on the owners.
    const half = driver.step(held, answer('A Calendly link.'), asMember(tim));
    expect(driver.events()).toEqual([
      { type: 'question_part_answered', needs: ['decision'], memberId: tim.id }
    ]);
    expect(half.blocked).toMatchObject({
      askedOf: { role: 'owner' },
      handoff: {
        parts: [
          { askedOf: { role: 'owner' }, needs: ['account'] },
          { askedOf: { domain: 'product' }, needs: ['decision'], answeredBy: tim.id }
        ]
      }
    });
    expect(driver.attempt(half, answer('Again.'), asMember(tim))).toEqual({
      ok: false,
      error: 'not_allowed'
    });

    const done = driver.step(half, answer('The account is open.'), asMember(owner));
    expect(done.blocked).toBeNull();
    expect(driver.events()).toContainEqual({ type: 'unblocked', answer: 'The account is open.' });
  });

  test('a split question still counts as held for the owner while their part waits', () => {
    const driver = createDriver(PROJECT);
    const held = handedOff(driver, ['decision', 'account']);
    expect(heldForOwner(held.blocked)).toBe(true);
    // Words that call for the owner in Tim's answer add the guard; the owner's part still holds it.
    const half = driver.step(held, answer('Keep the API key in the booking tool.'), asMember(tim));
    expect(half.guards).toContain('secrets');
    expect(half.blocked?.askedOf).toEqual({ role: 'owner' });
  });

  test("words that call for the owner join what is left to the owner's hold", () => {
    const driver = createDriver(PROJECT);
    const held = handedOff(driver, ['decision', 'tooling']);
    expect(heldForOwner(held.blocked)).toBe(false);
    const half = driver.step(held, answer('Store the password in the tool.'), asMember(tim));
    expect(half.blocked?.askedOf).toEqual({ role: 'owner' });
    expect(half.blocked?.handoff).toEqual({ needs: ['decision', 'tooling'] });
    expect(half.blocked?.question).toStartWith('This request is about');
    expect(half.blocked?.question).toContain('How investors book a call');
    expect(driver.events()).toContainEqual({ type: 'blocked', blocked: half.blocked! });
  });

  test('an owner may answer every part at once', () => {
    const driver = createDriver(PROJECT);
    const held = handedOff(driver, ['decision', 'account']);
    expect(driver.step(held, answer('Both done.'), asMember(owner)).blocked).toBeNull();
  });

  test('a question joined to a split one, or handed on, is asked as one again', () => {
    const driver = createDriver(PROJECT);
    const held = handedOff(driver, ['decision', 'account']);
    const joined = driver.step(
      held,
      { type: 'add_question', question: 'A branch moved.', askedOf: { role: 'maintainer' } },
      engine
    );
    // The owner's part ranks higher than the maintainer's question, so the owner reads both.
    expect(joined.blocked?.askedOf).toEqual({ role: 'owner' });
    expect(joined.blocked?.handoff).toEqual({ needs: ['decision', 'account'] });

    const handed = driver.step(held, { type: 'hand_question', memberId: gio.id }, asMember(owner));
    expect(handed.blocked?.askedOf).toEqual({ memberId: gio.id });
    expect(handed.blocked?.handoff).toEqual({ needs: ['decision', 'account'] });
  });
});

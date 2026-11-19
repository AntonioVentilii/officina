/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { inboxGroups } from '../src/lib/inbox';
import type { Card, Stage } from '../src/lib/types';

const card = (number: number, stage: Stage, extra: Partial<Card> = {}): Card => ({
  number,
  title: `Task ${number}`,
  stage,
  lane: 'standard',
  blocked: null,
  paused: false,
  userVisible: false,
  requester: 'Antonio',
  pullRequest: null,
  costCents: null,
  running: [],
  fixRounds: 0,
  specVersion: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  stageSince: '2026-01-01T00:00:00Z',
  autoVerified: false,
  autoMergeOn: false,
  learningPullRequests: [],
  waitingOn: { kind: 'people', label: 'Waiting on you', me: true },
  guards: [],
  ...extra
});

describe('inboxGroups', () => {
  test('every card waiting on the viewer is listed once, so the page never disagrees with the badge', () => {
    const cards = [
      card(1, 'spec_review', { blocked: { question: 'Which name?', needs: [] } }),
      card(2, 'spec_review', { paused: true }),
      card(3, 'triage'),
      card(4, 'spec_review'),
      card(5, 'ready'),
      card(6, 'building'),
      card(7, 'verifying'),
      card(8, 'merging'),
      card(9, 'reviewing'),
      card(10, 'done', {
        learningPullRequests: [{ number: 41, url: 'https://github.com/x/pull/41', state: 'open' }]
      })
    ];
    expect(
      inboxGroups(cards).map((group) => [group.id, group.cards.map((item) => item.number)])
    ).toEqual([
      ['questions', [1]],
      ['paused', [2]],
      ['triage', [3]],
      ['specs', [4]],
      ['claim', [5]],
      ['hand-in', [6]],
      ['verify', [7]],
      ['merge', [8]],
      ['learning', [10]],
      ['other', [9]]
    ]);
  });

  test('with nothing waiting there is no group at all', () => {
    expect(inboxGroups([])).toEqual([]);
  });
});

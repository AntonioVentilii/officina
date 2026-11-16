import type { Card } from './types';

/**
 * The Inbox's groups, in order. A card goes in the first one it matches, and the last one takes
 * the rest, so the page lists every card the Inbox badge counts.
 */
const GROUPS = [
  { id: 'questions', title: 'Questions for you', match: (card: Card) => Boolean(card.blocked) },
  { id: 'paused', title: 'Paused tasks', match: (card: Card) => card.paused },
  { id: 'triage', title: 'New requests to triage', match: (card: Card) => card.stage === 'triage' },
  { id: 'specs', title: 'Specs to approve', match: (card: Card) => card.stage === 'spec_review' },
  { id: 'claim', title: 'Builds to claim', match: (card: Card) => card.stage === 'ready' },
  {
    id: 'hand-in',
    title: 'Your builds to hand in',
    match: (card: Card) => card.stage === 'building'
  },
  { id: 'verify', title: 'Results to verify', match: (card: Card) => card.stage === 'verifying' },
  {
    id: 'merge',
    title: 'Ready to merge on GitHub',
    match: (card: Card) => card.stage === 'merging'
  },
  { id: 'other', title: 'Also waiting on you', match: () => true }
] as const;

export type InboxGroupId = (typeof GROUPS)[number]['id'];

/** The cards waiting on the viewer, each in its group; groups with no card are left out. */
export const inboxGroups = (cards: readonly Card[]) =>
  GROUPS.map(({ id, title }) => ({
    id,
    title,
    cards: cards.filter((card) => GROUPS.find((group) => group.match(card))?.id === id)
  })).filter((group) => group.cards.length);

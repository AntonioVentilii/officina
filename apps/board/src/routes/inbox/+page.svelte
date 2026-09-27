<script lang="ts">
  import { CircleHelp, GitMerge, Inbox, ListChecks, Sparkles } from '@lucide/svelte';
  import LaneChip from '$lib/components/LaneChip.svelte';
  import MemberAvatar from '$lib/components/MemberAvatar.svelte';
  import { since } from '$lib/format';
  import { board } from '$lib/state/board.svelte';
  import { clock } from '$lib/state/clock.svelte';
  import type { Card } from '$lib/types';

  const GROUPS = [
    {
      id: 'questions',
      title: 'Questions for you',
      icon: CircleHelp,
      match: (card: Card) => Boolean(card.blocked)
    },
    {
      id: 'triage',
      title: 'New requests to triage',
      icon: Sparkles,
      match: (card: Card) => card.stage === 'triage'
    },
    {
      id: 'specs',
      title: 'Specs to approve',
      icon: ListChecks,
      match: (card: Card) => card.stage === 'spec_review'
    },
    {
      id: 'verify',
      title: 'Results to verify',
      icon: ListChecks,
      match: (card: Card) => card.stage === 'verifying'
    },
    {
      id: 'merge',
      title: 'Ready to merge on GitHub',
      icon: GitMerge,
      match: (card: Card) => card.stage === 'merging'
    }
  ] as const;

  const groups = $derived(
    GROUPS.map((group) => ({
      ...group,
      cards: board.waitingOnMe.filter(
        (card) => group.match(card) && GROUPS.find((first) => first.match(card))?.id === group.id
      )
    })).filter((group) => group.cards.length)
  );
</script>

<div class="page">
  <header>
    <h1>Inbox</h1>
    <p class="muted">Everything that is waiting on you, oldest first within each group.</p>
  </header>

  {#if board.loaded && groups.length === 0}
    <div class="clear">
      <Inbox size={28} />
      <h2>Nothing is waiting on you</h2>
      <p class="muted">
        Agents keep working; new approvals and questions show up here as they happen.
      </p>
    </div>
  {/if}

  {#each groups as group (group.id)}
    <section>
      <h2>
        <group.icon size={15} />{group.title}<span class="faint num">{group.cards.length}</span>
      </h2>
      <ul>
        {#each [...group.cards].sort( (a, b) => a.stageSince.localeCompare(b.stageSince) ) as card (card.number)}
          <li>
            <a href="/tasks/{card.number}">
              <span class="number mono">#{card.number}</span>
              <span class="title">{card.title}</span>
              <span class="lane-cell"><LaneChip lane={card.lane} /></span>
              <span class="label faint"
                >{card.blocked ? card.blocked.question : card.waitingOn.label}</span
              >
              <MemberAvatar name={card.requester} size={20} />
              <span class="age faint num" title="Waiting for"
                >{since(card.stageSince, clock.now)}</span
              >
            </a>
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>

<style>
  .page {
    height: 100%;
    overflow-y: auto;
    padding: 18px 24px 40px;
    max-width: 980px;
  }

  header h1 {
    margin: 0;
    font-size: 20px;
    letter-spacing: -0.02em;
  }

  header p {
    margin: 4px 0 20px;
  }

  section + section {
    margin-top: 24px;
  }

  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 650;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--panel);
    overflow: hidden;
  }

  li + li {
    border-top: 1px solid var(--border);
  }

  a {
    display: grid;
    grid-template-columns: auto minmax(0, 1.2fr) auto minmax(0, 1fr) auto 44px;
    align-items: center;
    gap: 12px;
    padding: 11px 14px;
  }

  a:hover {
    background: var(--hover);
  }

  .number {
    font-size: 12px;
    color: var(--text-3);
  }

  .title {
    font-weight: 560;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .label {
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .age {
    font-size: 12px;
    text-align: right;
  }

  .clear {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 60px 20px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-lg);
    color: var(--text-3);
    text-align: center;
  }

  .clear h2 {
    color: var(--text);
    font-size: 15px;
    margin: 6px 0 0;
  }

  @media (max-width: 720px) {
    .page {
      padding: 14px 16px 24px;
    }

    a {
      grid-template-columns: auto minmax(0, 1fr) 40px;
    }

    .lane-cell,
    .label,
    a > :global(.avatar) {
      display: none;
    }
  }
</style>

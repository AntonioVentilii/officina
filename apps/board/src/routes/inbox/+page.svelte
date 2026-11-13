<script lang="ts">
  import { Bell, CircleHelp, GitMerge, Inbox, ListChecks, Sparkles, X } from '@lucide/svelte';
  import LaneChip from '$lib/components/LaneChip.svelte';
  import MemberAvatar from '$lib/components/MemberAvatar.svelte';
  import { since } from '$lib/format';
  import { board } from '$lib/state/board.svelte';
  import { clock } from '$lib/state/clock.svelte';
  import { toasts } from '$lib/state/toasts.svelte';
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

  const dismiss = (id: string) =>
    board.dismiss(id).catch((error: Error) => toasts.show('error', error.message));
</script>

<div class="page">
  <header>
    <h1 class="page-title">Inbox</h1>
    <p class="muted">Everything that is waiting on you, oldest first within each group.</p>
  </header>

  {#if board.notices.length}
    <section>
      <h2><Bell size={18} />News<span class="count num">{board.notices.length}</span></h2>
      <ul>
        {#each board.notices as notice (notice.id)}
          <li class="notice">
            <span class="title">{notice.text}</span>
            <span class="age num" title="When">{since(notice.createdAt, clock.now)}</span>
            <button
              class="btn ghost icon sm"
              onclick={() => dismiss(notice.id)}
              title="Mark as read"
              aria-label="Mark as read"><X size={14} /></button
            >
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if board.loaded && groups.length === 0 && board.notices.length === 0}
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
        <group.icon size={18} />{group.title}<span class="count num">{group.cards.length}</span>
      </h2>
      <ul>
        {#each [...group.cards].sort( (a, b) => a.stageSince.localeCompare(b.stageSince) ) as card (card.number)}
          <li>
            <a href="/tasks/{card.number}">
              <span class="number caps num">#{card.number}</span>
              <span class="title">{card.title}</span>
              <span class="lane-cell"><LaneChip lane={card.lane} /></span>
              <span class="label"
                >{card.blocked ? card.blocked.question : card.waitingOn.label}</span
              >
              <MemberAvatar name={card.requester} size={20} />
              <span class="age num" title="Waiting for">{since(card.stageSince, clock.now)}</span>
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
    padding-bottom: 48px;
  }

  header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px 28px;
    margin-bottom: 28px;
    padding: 28px 32px 22px;
    border-bottom: 3px solid var(--rule);
  }

  header p {
    margin: 0;
    max-width: 420px;
  }

  section,
  .clear {
    max-width: 1040px;
    margin: 0 32px;
  }

  section + section {
    margin-top: 36px;
  }

  h2 {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--rule);
    font-size: 22px;
    font-weight: 800;
    font-stretch: 75%;
  }

  .count {
    margin-left: auto;
    font-size: 40px;
    font-weight: 300;
    font-stretch: 62%;
    line-height: 0.75;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    border-bottom: 1px solid var(--border);
  }

  a {
    display: grid;
    grid-template-columns: 44px minmax(0, 1.2fr) auto minmax(0, 1fr) auto 44px;
    align-items: center;
    gap: 14px;
    padding: 13px 4px;
  }

  a:hover {
    background: var(--hover);
  }

  .notice {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 44px auto;
    align-items: center;
    gap: 14px;
    padding: 9px 4px;
  }

  .number {
    font-weight: 800;
  }

  .title {
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lane-cell {
    display: inline-flex;
  }

  .label {
    font-size: 13px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .age {
    font-size: 12.5px;
    font-stretch: 85%;
    color: var(--text-2);
    text-align: right;
  }

  .clear {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: 12px 0;
    color: var(--text-2);
  }

  .clear h2 {
    padding: 0;
    border: 0;
    color: var(--text);
    font-size: 28px;
    margin: 8px 0 0;
  }

  .clear p {
    margin: 0;
  }

  /* Tecnica: a ruled header strip and condensed section heads, numbers in mono. */
  :global([data-look='tecnica']) header {
    align-items: center;
    padding: 18px 24px;
    background: var(--panel);
    border-bottom-width: 1.5px;
  }

  :global([data-look='tecnica']) h2 {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    font-stretch: normal;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  :global([data-look='tecnica']) .count {
    font-size: 12px;
    font-weight: 400;
    font-stretch: normal;
    line-height: 1.5;
  }

  :global([data-look='tecnica']) ul {
    border: 1.5px solid var(--rule);
    border-top: 0;
    background: var(--panel);
  }

  :global([data-look='tecnica']) a,
  :global([data-look='tecnica']) .notice {
    padding: 11px 12px;
  }

  :global([data-look='tecnica']) .number {
    font-weight: 400;
  }

  :global([data-look='tecnica']) .title {
    font-weight: 500;
  }

  :global([data-look='tecnica']) .clear h2 {
    font-size: 20px;
  }

  @media (max-width: 720px) {
    header {
      padding: 20px 16px 16px;
    }

    header :global(.page-title) {
      font-size: 56px;
    }

    section,
    .clear {
      margin: 0 16px;
    }

    a {
      grid-template-columns: 40px minmax(0, 1fr) 40px;
    }

    .lane-cell,
    .label,
    a > :global(.avatar) {
      display: none;
    }
  }
</style>

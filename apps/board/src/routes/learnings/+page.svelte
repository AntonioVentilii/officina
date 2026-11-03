<script lang="ts">
  import { goto } from '$app/navigation';
  import { session } from '$lib/state/session.svelte';
  import { GraduationCap } from '@lucide/svelte';
  import LearningCard from '$lib/components/LearningCard.svelte';
  import { board } from '$lib/state/board.svelte';
  import type { Learning } from '$lib/types';

  const FILTERS = [
    { id: 'proposed', label: 'To decide' },
    { id: 'accepted', label: 'Accepted' },
    { id: 'applied', label: 'Applied' },
    { id: 'rejected', label: 'Rejected' }
  ] as const;

  let filter = $state<Learning['status']>('proposed');

  const shown = $derived(board.learnings.filter((item) => item.status === filter));
  const count = (status: Learning['status']) =>
    board.learnings.filter((item) => item.status === status).length;

  // Maintainers' page: the API refuses its data to anyone else.
  $effect(() => {
    if (session.project && !session.technical) void goto('/', { replaceState: true });
  });
</script>

<div class="page">
  <header>
    <h1 class="page-title">Learnings</h1>
    <p class="muted">
      After every merged task the learner looks back at what slowed it down and proposes an exact
      edit to the project's docs or to an agent's prompt. Accepting a project learning opens a pull
      request; people merge it as usual.
    </p>
  </header>

  <div class="tabs" role="group" aria-label="Status">
    {#each FILTERS as item (item.id)}
      <button
        class:on={filter === item.id}
        aria-pressed={filter === item.id}
        onclick={() => (filter = item.id)}
      >
        {item.label}<span class="count num">{count(item.id)}</span>
      </button>
    {/each}
  </div>

  {#if board.loaded && shown.length === 0}
    <div class="empty">
      <GraduationCap size={26} />
      <p>
        {filter === 'proposed'
          ? 'Nothing to decide. The learner looks at each task once it is merged.'
          : 'None yet.'}
      </p>
    </div>
  {/if}

  <div class="list">
    {#each shown as learning (learning.id)}
      <LearningCard {learning} />
    {/each}
  </div>
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
    padding: 28px 32px 22px;
    border-bottom: 3px solid var(--rule);
  }

  header p {
    margin: 0;
    max-width: 560px;
  }

  .tabs,
  .list,
  .empty {
    max-width: 920px;
    margin-left: 32px;
    margin-right: 32px;
  }

  .tabs {
    display: flex;
    gap: 24px;
    margin-top: 22px;
    border-bottom: 1px solid var(--rule);
  }

  .tabs button {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    padding: 4px 0 8px;
    margin-bottom: -1px;
    border: 0;
    border-bottom: 3px solid transparent;
    background: none;
    color: var(--text-2);
    font-size: 14px;
    font-weight: 600;
  }

  .tabs button:hover {
    color: var(--text);
  }

  .tabs button.on {
    color: var(--text);
    border-bottom-color: var(--rule);
  }

  .count {
    font-size: 15px;
    font-weight: 300;
    font-stretch: 75%;
  }

  .list {
    display: flex;
    flex-direction: column;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 28px 0;
    color: var(--text-2);
  }

  @media (max-width: 720px) {
    header {
      padding: 20px 16px 16px;
    }

    header :global(.page-title) {
      font-size: 56px;
    }

    .tabs,
    .list,
    .empty {
      margin-left: 16px;
      margin-right: 16px;
    }

    .tabs {
      overflow-x: auto;
    }
  }
</style>

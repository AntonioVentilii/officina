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
    <h1>Learnings</h1>
    <p class="muted">
      After every merged task the learner looks back at what slowed it down and proposes an exact
      edit to the project's docs or to an agent's prompt. Accepting a project learning opens a pull
      request; people merge it as usual.
    </p>
  </header>

  <div class="segmented" role="group" aria-label="Status">
    {#each FILTERS as item (item.id)}
      <button class:on={filter === item.id} onclick={() => (filter = item.id)}>
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
    padding: 18px 24px 40px;
    max-width: 920px;
  }

  h1 {
    margin: 0;
    font-size: 20px;
    letter-spacing: -0.02em;
  }

  header p {
    margin: 4px 0 16px;
    max-width: 680px;
  }

  .segmented {
    display: inline-flex;
    padding: 2px;
    margin-bottom: 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--panel);
  }

  .segmented button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--text-2);
    font-size: 12.5px;
    font-weight: 500;
  }

  .segmented button.on {
    background: var(--panel-3);
    color: var(--text);
  }

  .count {
    font-size: 11px;
    color: var(--text-3);
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 48px 20px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-lg);
    color: var(--text-3);
    text-align: center;
  }

  @media (max-width: 720px) {
    .page {
      padding: 14px 16px 24px;
    }

    .segmented {
      display: flex;
      overflow-x: auto;
    }
  }
</style>

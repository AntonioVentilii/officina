<script lang="ts">
  import { Plus, Search } from '@lucide/svelte';
  import { page } from '$app/state';
  import { COLUMNS, CLOSED } from '$lib/stages';
  import { board } from '$lib/state/board.svelte';
  import { clock } from '$lib/state/clock.svelte';
  import { session } from '$lib/state/session.svelte';
  import type { Card, Lane } from '$lib/types';
  import LaneChip from './LaneChip.svelte';
  import NewRequest from './NewRequest.svelte';
  import TaskCard from './TaskCard.svelte';

  let query = $state('');
  let onlyMine = $state(false);
  let lanes = $state<Lane[]>([]);
  let showClosed = $state(false);
  let creating = $state(false);

  const activeNumber = $derived(Number(page.params.number ?? 0));

  const matches = (card: Card) => {
    const q = query.trim().toLowerCase();
    if (q && !card.title.toLowerCase().includes(q) && !`#${card.number}`.includes(q)) return false;
    if (onlyMine && !card.waitingOn.me) return false;
    if (lanes.length && (!card.lane || !lanes.includes(card.lane))) return false;
    return true;
  };

  const visible = $derived(board.tasks.filter(matches));
  const columns = $derived([
    ...COLUMNS.map((column) => ({
      ...column,
      cards: visible.filter((card) => column.stages.includes(card.stage))
    })),
    ...(showClosed
      ? [
          {
            id: 'closed',
            title: 'Closed',
            hint: 'Declined or cancelled',
            stages: CLOSED,
            cards: visible.filter((card) => CLOSED.includes(card.stage))
          }
        ]
      : [])
  ]);

  const closedCount = $derived(board.tasks.filter((card) => CLOSED.includes(card.stage)).length);

  const toggleLane = (lane: Lane) =>
    (lanes = lanes.includes(lane) ? lanes.filter((item) => item !== lane) : [...lanes, lane]);

  const canRequest = $derived(session.can('request'));
</script>

<section class="board">
  <header class="toolbar">
    <h1 class="page-title">Board</h1>
    <div class="stats">
      <div class="stat">
        <span class="caps muted">Open</span>
        <span class="figure num">{board.tasks.length - closedCount}</span>
      </div>
      <div class="stat">
        <span class="caps muted">Waiting on you</span>
        <span class="figure num">{board.waitingOnMe.length}</span>
      </div>
    </div>

    <div class="filters">
      <label class="search">
        <Search size={15} />
        <input bind:value={query} placeholder="Filter tasks" aria-label="Filter tasks" />
      </label>
      <div class="tabs" role="group" aria-label="Show">
        <button class:on={!onlyMine} aria-pressed={!onlyMine} onclick={() => (onlyMine = false)}
          >All</button
        >
        <button class:on={onlyMine} aria-pressed={onlyMine} onclick={() => (onlyMine = true)}
          >Waiting on me{#if board.waitingOnMe.length}<span class="tab-count num"
              >{board.waitingOnMe.length}</span
            >{/if}</button
        >
      </div>
      {#if session.technical}
        <div class="lanes" role="group" aria-label="Risk">
          {#each ['green', 'standard', 'red'] as const as lane (lane)}
            <button
              class="lane"
              class:on={lanes.includes(lane)}
              aria-pressed={lanes.includes(lane)}
              onclick={() => toggleLane(lane)}
            >
              <LaneChip {lane} showStandard named />
            </button>
          {/each}
        </div>
      {/if}
      {#if closedCount}
        <button class="btn ghost sm" onclick={() => (showClosed = !showClosed)}>
          {showClosed ? 'Hide' : 'Show'} closed ({closedCount})
        </button>
      {/if}
    </div>

    {#if canRequest}
      <button class="btn primary new" onclick={() => (creating = true)}>
        <Plus size={16} strokeWidth={2.5} />New request
      </button>
    {/if}
  </header>
  {#if board.error}
    <p class="load-error" role="alert">
      The board could not load: {board.error}
      <button class="btn ghost sm" onclick={() => void board.refresh()}>Try again</button>
    </p>
  {/if}

  <div class="columns">
    {#each columns as column, index (column.id)}
      <section class="column" aria-label={column.title}>
        <div class="column-head" title={column.hint}>
          <span class="column-no num">{String(index + 1).padStart(2, '0')}</span>
          <h2 class="column-title">
            {column.title}
            {#if column.cards.some((card) => card.running.length)}
              <span class="live-dot" title="An agent is working here"></span>
            {/if}
          </h2>
          <span class="column-count num">{column.cards.length}</span>
        </div>
        <div class="cards">
          {#each column.cards as card (card.number)}
            <TaskCard
              {card}
              repo={session.project?.repo ?? null}
              now={clock.now}
              active={activeNumber === card.number}
            />
          {:else}
            <div class="empty">{board.loaded ? column.hint : ''}</div>
          {/each}
        </div>
      </section>
    {/each}
  </div>
</section>

{#if creating}
  <NewRequest onclose={() => (creating = false)} />
{/if}

<style>
  .load-error {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 12px;
    color: var(--danger);
  }

  .board {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  /* Title, figures and the one action on top; the filters run underneath as a strip. */
  .toolbar {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    grid-template-areas:
      'title stats . action'
      'filters filters filters filters';
    align-items: end;
    gap: 22px 28px;
    padding: 28px 32px 18px;
    border-bottom: 3px solid var(--rule);
  }

  .toolbar > :global(.page-title) {
    grid-area: title;
  }

  .stats {
    grid-area: stats;
    display: flex;
    gap: 28px;
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-bottom: 2px;
  }

  .stat .caps {
    font-size: 12px;
    letter-spacing: 0.1em;
  }

  .figure {
    font-size: 28px;
    font-weight: 300;
    font-stretch: 62%;
    line-height: 1;
  }

  .filters {
    grid-area: filters;
    display: flex;
    align-items: flex-end;
    gap: 14px 28px;
    flex-wrap: wrap;
  }

  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 190px;
    padding: 6px 0;
    border-bottom: 2px solid var(--rule);
    color: var(--text-2);
  }

  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    outline: none;
    color: var(--text);
    font-size: 15px;
  }

  .tabs,
  .lanes {
    display: flex;
    gap: 18px;
  }

  .tabs button,
  .lane {
    padding: 4px 0;
    border: 0;
    border-bottom: 3px solid transparent;
    background: none;
    color: var(--text-2);
    font-size: 14px;
    font-weight: 600;
  }

  .tabs button:hover,
  .lane:hover {
    color: var(--text);
  }

  .tabs button.on,
  .lane.on {
    color: var(--text);
    border-bottom-color: var(--rule);
  }

  .lane {
    font-weight: 500;
  }

  .new {
    grid-area: action;
    height: 44px;
    padding: 0 22px;
    font-size: 15px;
  }

  .columns {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(230px, 1fr);
    overflow-x: auto;
  }

  .column {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--rule);
  }

  .column-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 8px;
    padding: 18px 18px 14px;
    border-bottom: 1px solid var(--rule);
  }

  .column-title {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    font-size: 22px;
    font-weight: 800;
    font-stretch: 75%;
    line-height: 1.1;
  }

  .column-count {
    font-size: 64px;
    font-weight: 300;
    font-stretch: 62%;
    line-height: 0.75;
  }

  .live-dot {
    width: 9px;
    height: 9px;
    background: var(--text);
    animation: signal 1.2s ease-in-out infinite;
  }

  .cards {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .empty {
    padding: 16px 18px;
    color: var(--text-3);
    font-size: 13px;
  }

  /* Only Tecnica numbers its columns and repeats the count on the tab; Modernista has the figure. */
  .column-no,
  .tab-count {
    display: none;
  }

  /* Tecnica: a ruled header strip, boxed controls, and work orders stacked on graph paper. */
  :global([data-look='tecnica']) .toolbar {
    align-items: center;
    gap: 14px 16px;
    padding: 16px 24px;
    background: var(--panel);
    border-bottom: 1.5px solid var(--rule);
  }

  :global([data-look='tecnica']) .stats {
    gap: 16px;
  }

  :global([data-look='tecnica']) .stat {
    flex-direction: row-reverse;
    gap: 6px;
    padding: 0;
    font-family: var(--font-num);
  }

  :global([data-look='tecnica']) .stat .caps {
    font-size: 13px;
    letter-spacing: 0.02em;
  }

  :global([data-look='tecnica']) .figure {
    font-size: 13px;
    font-weight: 400;
    line-height: 1.5;
    color: var(--text-2);
  }

  :global([data-look='tecnica']) .filters {
    align-items: center;
    gap: 12px 16px;
  }

  :global([data-look='tecnica']) .search {
    height: 36px;
    padding: 0 10px;
    border: 1.5px solid var(--rule);
    background: var(--bg);
  }

  :global([data-look='tecnica']) .search input {
    font-size: 14px;
  }

  :global([data-look='tecnica']) .tabs {
    gap: 0;
    border: 1.5px solid var(--rule);
  }

  :global([data-look='tecnica']) .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 33px;
    padding: 0 14px;
    border: 0;
    background: var(--panel);
    color: var(--text);
    font-size: 13px;
  }

  :global([data-look='tecnica']) .tabs button + button {
    border-left: 1.5px solid var(--rule);
  }

  :global([data-look='tecnica']) .tabs button.on {
    background: var(--tint);
  }

  :global([data-look='tecnica']) .tab-count {
    display: inline;
    padding: 0 5px;
    background: var(--accent);
    color: var(--accent-text);
    font-weight: 400;
  }

  :global([data-look='tecnica']) .lanes {
    gap: 14px;
  }

  :global([data-look='tecnica']) .lane {
    padding: 2px 0;
    border-bottom-width: 1.5px;
    color: var(--text);
    font-size: 13px;
  }

  :global([data-look='tecnica']) .new {
    height: 36px;
    padding: 0 16px;
    font-size: 14px;
  }

  :global([data-look='tecnica']) .column {
    border-right: 1px solid var(--border);
  }

  :global([data-look='tecnica']) .column-head {
    align-items: baseline;
    justify-content: flex-start;
    gap: 10px;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--border);
  }

  :global([data-look='tecnica']) .column-no {
    display: inline;
    font-size: 12px;
    color: var(--text-2);
  }

  :global([data-look='tecnica']) .column-title {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  :global([data-look='tecnica']) .column-count {
    margin-left: auto;
    font-size: 12px;
    font-weight: 400;
    line-height: 1.5;
  }

  :global([data-look='tecnica']) .cards {
    gap: 12px;
    padding: 12px;
  }

  :global([data-look='tecnica']) .empty {
    padding: 4px;
    font-size: 12.5px;
  }

  @media (max-width: 720px) {
    .toolbar {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        'title action'
        'stats stats'
        'filters filters';
      gap: 14px 20px;
      padding: 20px 16px 16px;
    }

    .toolbar :global(.page-title) {
      font-size: 56px;
    }

    .filters {
      flex-wrap: nowrap;
      overflow-x: auto;
      margin: 0 -16px;
      padding: 0 16px 2px;
      scrollbar-width: none;
    }

    .filters > * {
      flex: none;
    }

    .new {
      height: 38px;
      padding: 0 14px;
    }

    .columns {
      grid-auto-columns: calc(100vw - 32px);
      scroll-snap-type: x mandatory;
    }

    .column {
      scroll-snap-align: start;
    }

    .search {
      width: 160px;
    }
  }
</style>

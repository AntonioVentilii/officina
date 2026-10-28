<script lang="ts">
  import { Plus, Search } from '@lucide/svelte';
  import { page } from '$app/state';
  import { COLUMNS, CLOSED } from '$lib/stages';
  import { board } from '$lib/state/board.svelte';
  import { clock } from '$lib/state/clock.svelte';
  import { session } from '$lib/state/session.svelte';
  import type { Card, Lane } from '$lib/types';
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

  const canRequest = $derived(session.project?.role !== 'watcher');
</script>

<section class="board">
  <header class="toolbar">
    <div class="heading">
      <h1>Board</h1>
      <span class="count faint num">{board.tasks.length - closedCount} open</span>
    </div>

    <div class="filters">
      <label class="search">
        <Search size={14} />
        <input bind:value={query} placeholder="Filter tasks" aria-label="Filter tasks" />
      </label>
      <div class="segmented" role="group" aria-label="Show">
        <button class:on={!onlyMine} onclick={() => (onlyMine = false)}>All</button>
        <button class:on={onlyMine} onclick={() => (onlyMine = true)}>
          Waiting on me
          {#if board.waitingOnMe.length}<span class="badge num">{board.waitingOnMe.length}</span
            >{/if}
        </button>
      </div>
      {#if session.technical}
        <div class="lanes" role="group" aria-label="Risk">
          {#each [['green', 'Low risk'], ['standard', 'Standard'], ['red', 'Sensitive']] as const as [lane, label] (lane)}
            <button
              class="lane {lane}"
              class:on={lanes.includes(lane)}
              onclick={() => toggleLane(lane)}
            >
              <span class="dot"></span>{label}
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
      <button class="btn primary" onclick={() => (creating = true)}>
        <Plus size={15} strokeWidth={2.5} />New request
      </button>
    {/if}
  </header>

  <div class="columns">
    {#each columns as column (column.id)}
      <div class="column">
        <div class="column-head" title={column.hint}>
          <span class="column-title">{column.title}</span>
          <span class="column-count num">{column.cards.length}</span>
          {#if column.cards.some((card) => card.running.length)}
            <span class="live-dot" title="An agent is working here"></span>
          {/if}
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
      </div>
    {/each}
  </div>
</section>

{#if creating}
  <NewRequest onclose={() => (creating = false)} />
{/if}

<style>
  .board {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .toolbar {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas: 'heading filters action';
    align-items: center;
    gap: 12px 16px;
    padding: 18px 24px 14px;
  }

  .toolbar > .btn {
    grid-area: action;
  }

  .heading {
    grid-area: heading;
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 650;
    letter-spacing: -0.02em;
  }

  .count {
    font-size: 12.5px;
  }

  .filters {
    grid-area: filters;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .search {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--panel);
    color: var(--text-3);
    width: 200px;
  }

  .search:focus-within {
    border-color: var(--accent);
  }

  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    outline: none;
    color: var(--text);
    font-size: 13px;
  }

  .segmented {
    display: inline-flex;
    padding: 2px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--panel);
  }

  .segmented button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
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

  .badge {
    min-width: 17px;
    height: 17px;
    padding: 0 5px;
    border-radius: 999px;
    font-size: 10.5px;
    font-weight: 700;
    line-height: 17px;
    background: var(--accent);
    color: var(--accent-text);
  }

  .lanes {
    display: inline-flex;
    gap: 4px;
  }

  .lane {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 9px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: none;
    color: var(--text-2);
    font-size: 12px;
  }

  .lane .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--c);
  }

  .lane.on {
    border-color: var(--c);
    color: var(--text);
    background: color-mix(in srgb, var(--c) 10%, transparent);
  }

  .lane.green {
    --c: var(--lane-green);
  }

  .lane.standard {
    --c: var(--lane-standard);
  }

  .lane.red {
    --c: var(--lane-red);
  }

  .columns {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 12px;
    padding: 4px 24px 24px;
    overflow-x: auto;
  }

  .column {
    flex: 1 0 272px;
    max-width: 360px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--panel-2) 55%, transparent);
    border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  }

  .column-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 11px 13px 9px;
  }

  .column-title {
    font-size: 12.5px;
    font-weight: 650;
    letter-spacing: 0.01em;
  }

  .column-count {
    font-size: 11.5px;
    color: var(--text-3);
  }

  .live-dot {
    width: 7px;
    height: 7px;
    margin-left: auto;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
    animation: pulse 1.6s ease-in-out infinite;
  }

  .cards {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 2px 8px 10px;
    overflow-y: auto;
  }

  .empty {
    display: grid;
    place-items: center;
    min-height: 72px;
    padding: 10px;
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    color: var(--text-3);
    font-size: 12px;
    text-align: center;
  }

  @media (max-width: 720px) {
    .toolbar {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        'heading action'
        'filters filters';
      padding: 14px 16px 10px;
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

    .columns {
      padding: 4px 16px 16px;
      scroll-snap-type: x mandatory;
    }

    .column {
      flex-basis: calc(100vw - 48px);
      scroll-snap-align: start;
    }

    .search {
      width: 170px;
    }
  }
</style>

<script lang="ts">
  import { Check } from '@lucide/svelte';
  import { CLOSED, TRACK, trackIndex } from '$lib/stages';
  import type { Stage } from '$lib/types';

  interface Props {
    stage: Stage;
    working?: boolean;
  }

  let { stage, working = false }: Props = $props();

  const current = $derived(trackIndex(stage));
  const closed = $derived(CLOSED.includes(stage));
</script>

<ol class="track" class:closed aria-label="Progress">
  {#each TRACK as step, index (step.label)}
    {@const state =
      stage === 'done' || index < current ? 'past' : index === current ? 'current' : 'future'}
    <li
      class={state}
      class:working={state === 'current' && working}
      aria-current={state === 'current' ? 'step' : undefined}
    >
      <span class="node">
        {#if state === 'past'}<Check size={11} strokeWidth={3} />{/if}
      </span>
      <span class="label">{step.label}</span>
    </li>
  {/each}
</ol>

<style>
  .track {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-3);
  }

  li:not(:first-child)::before {
    content: '';
    position: absolute;
    top: 8px;
    right: 50%;
    width: 100%;
    height: 2px;
    background: var(--border);
    z-index: 0;
  }

  li.past::before,
  li.current::before {
    background: var(--accent);
  }

  .node {
    position: relative;
    z-index: 1;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--panel);
    border: 2px solid var(--border-strong);
    color: var(--accent-text);
  }

  .past .node {
    background: var(--accent);
    border-color: var(--accent);
  }

  .current .node {
    border-color: var(--accent);
    box-shadow: 0 0 0 4px var(--accent-soft);
  }

  .current .node::after {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }

  .working .node::after {
    animation: pulse 1.2s ease-in-out infinite;
  }

  .current .label {
    color: var(--text);
    font-weight: 600;
  }

  .past .label {
    color: var(--text-2);
  }

  .closed {
    opacity: 0.5;
    filter: grayscale(1);
  }

  @media (max-width: 640px) {
    .label {
      display: none;
    }

    .current .label {
      display: block;
      position: absolute;
      top: 24px;
      white-space: nowrap;
    }

    .track {
      padding-bottom: 18px;
    }
  }
</style>

<script lang="ts">
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
      <span class="bar"></span>
      <span class="label">{step.label}</span>
    </li>
  {/each}
</ol>

<style>
  /* A segmented rule: done steps are solid ink, the current one is thick, the rest a hairline. */
  .track {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-direction: column;
    gap: 7px;
    font-size: 11.5px;
    font-stretch: 85%;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
  }

  .bar {
    display: flex;
    align-items: flex-end;
    height: 6px;
  }

  .bar::before {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .past .bar::before {
    height: 3px;
    background: var(--rule);
  }

  .current .bar::before {
    height: 6px;
    background: var(--rule);
  }

  .working .bar::before {
    animation: signal 1.2s ease-in-out infinite;
  }

  .current .label {
    color: var(--text);
    font-weight: 800;
  }

  .past .label {
    color: var(--text-2);
  }

  .closed {
    opacity: 0.45;
  }

  @media (max-width: 640px) {
    .label {
      display: none;
    }

    .current .label {
      display: block;
      white-space: nowrap;
    }
  }
</style>

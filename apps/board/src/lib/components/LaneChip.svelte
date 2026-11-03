<script lang="ts">
  import { look } from '$lib/state/look.svelte';
  import type { Lane } from '$lib/types';

  interface Props {
    lane: Lane | null;
    /** Standard is the usual case, so it is only named where people look for it. */
    showStandard?: boolean;
    /** Writes the lane's name next to the marker, where there is room for it. */
    named?: boolean;
  }

  let { lane, showStandard = false, named = false }: Props = $props();

  const LABELS: Record<Lane, string> = {
    green: 'Low risk',
    standard: 'Standard',
    red: 'Sensitive'
  };
  const TITLES: Record<Lane, string> = {
    green: 'Copy and other low-risk changes (green lane)',
    standard: 'An ordinary change (standard lane)',
    red: 'Touches protected code: a person builds it (red lane)'
  };
</script>

{#if lane && (lane !== 'standard' || showStandard)}
  <span class="lane" class:tecnica={look.current === 'tecnica'} title={TITLES[lane]}>
    {#if named}
      <span class="mark {lane}" aria-hidden="true"></span><span>{LABELS[lane]}</span>
    {:else}
      <span class="mark {lane}" role="img" aria-label={LABELS[lane]}></span>
    {/if}
  </span>
{/if}

<style>
  .lane {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }

  /* Risk reads as a fill level: an empty ring, half full, full. */
  .mark {
    position: relative;
    flex: none;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 2px solid currentColor;
    overflow: hidden;
  }

  .standard::after {
    content: '';
    position: absolute;
    inset: 0 50% 0 0;
    background: currentColor;
  }

  .red {
    background: currentColor;
  }

  /* Tecnica marks risk by hatching: an open box, vertical ruling, red cross-hatching. */
  .tecnica .mark {
    width: 22px;
    height: 11px;
    border-radius: 0;
    border-width: 1.5px;
  }

  .tecnica .standard {
    background: repeating-linear-gradient(90deg, currentColor 0 1.5px, transparent 1.5px 5px);
  }

  .tecnica .standard::after {
    content: none;
  }

  .tecnica .red {
    color: var(--danger);
    background: repeating-linear-gradient(45deg, currentColor 0 1.5px, transparent 1.5px 4px);
  }

  .tecnica:has(.red) {
    color: var(--danger);
  }
</style>

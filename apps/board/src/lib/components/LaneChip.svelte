<script lang="ts">
  import type { Lane } from '$lib/types';

  interface Props {
    lane: Lane | null;
    /** Standard is the usual case, so it is only named where people look for it. */
    showStandard?: boolean;
  }

  let { lane, showStandard = false }: Props = $props();

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
  <span class="lane {lane}" title={TITLES[lane]}><span class="dot"></span>{LABELS[lane]}</span>
{/if}

<style>
  .lane {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 18px;
    padding: 0 6px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    color: var(--c);
    background: color-mix(in srgb, var(--c) 12%, transparent);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--c);
  }

  .green {
    --c: var(--lane-green);
  }

  .standard {
    --c: var(--lane-standard);
  }

  .red {
    --c: var(--lane-red);
  }
</style>

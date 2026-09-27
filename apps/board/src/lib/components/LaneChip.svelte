<script lang="ts">
  import type { Lane } from '$lib/types';

  interface Props {
    lane: Lane | null;
  }

  let { lane }: Props = $props();

  const TITLES: Record<Lane, string> = {
    green: 'Green lane: copy and low-risk changes',
    standard: 'Standard lane',
    red: 'Red lane: protected paths, a person builds it'
  };
</script>

{#if lane}
  <span class="lane {lane}" title={TITLES[lane]}><span class="dot"></span>{lane}</span>
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
    text-transform: lowercase;
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

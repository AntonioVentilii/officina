<script lang="ts">
  import { look as current } from '#lib/state/look.svelte.ts';
  import type { Look } from '#lib/types.ts';
  import favicon from '../../../static/favicon.svg?raw';

  interface Props {
    size?: number;
    /** Draws a given look's mark, as the look picker does; otherwise the current one. */
    look?: Look;
  }

  let { size = 28, look }: Props = $props();

  const shown = $derived(look ?? current.current);

  // The anvil is drawn once, in the favicon (the README shows it too), so the mark cannot drift.
  const ANVIL = /<path\b[^>]*?\sd\s*=\s*(["'])(.+?)\1/.exec(favicon)?.[2];
  if (!ANVIL) throw new Error('static/favicon.svg has no anvil path');

  // One anvil for every look; only its colours change: yellow on ink, ink on highlighter, or white
  // on the forge, a tile that runs from the builder's orange to the spec's violet.
  const COLORS: Record<
    Look,
    { tile: readonly [string, ...string[]]; anvil: string; round: number }
  > = {
    fucina: { tile: ['#ff5a1f', '#ff4fa3', '#9b6bff'], anvil: '#ffffff', round: 9 },
    modernista: { tile: ['#111111'], anvil: '#ffd400', round: 0 },
    tecnica: { tile: ['#f2c200'], anvil: '#14171a', round: 0 }
  };

  // Several logos share a page (the look picker draws one per look), so each gradient needs its own id.
  const uid = $props.id();
  const gradient = `forge-${uid}`;
  const colors = $derived(COLORS[shown]);
</script>

<svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
  {#if colors.tile.length > 1}
    <defs>
      <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
        {#each colors.tile as stop, index (stop)}
          <stop offset={index / (colors.tile.length - 1)} stop-color={stop} />
        {/each}
      </linearGradient>
    </defs>
  {/if}
  <rect
    width="32"
    height="32"
    rx={colors.round}
    fill={colors.tile.length > 1 ? `url(#${gradient})` : colors.tile[0]}
  />
  <path d={ANVIL} fill={colors.anvil} />
</svg>

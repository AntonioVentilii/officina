<script lang="ts">
  import { look as current } from '$lib/state/look.svelte';
  import type { Look } from '$lib/types';
  import favicon from '../../../static/favicon.svg?raw';

  interface Props {
    size?: number;
    /** Draws a given look's mark, as the look picker does; otherwise the current one. */
    look?: Look;
  }

  let { size = 28, look }: Props = $props();

  const shown = $derived(look ?? current.current);

  // The anvil is drawn once, in the favicon (the README shows it too), so the mark cannot drift.
  const ANVIL = /<path d="([^"]+)"/.exec(favicon)?.[1];
  if (!ANVIL) throw new Error('static/favicon.svg has no anvil path');

  // One anvil for every look; only its colours change: yellow on ink, or ink on highlighter.
  const COLORS: Record<Look, { tile: string; anvil: string }> = {
    modernista: { tile: '#111111', anvil: '#ffd400' },
    tecnica: { tile: '#f2c200', anvil: '#14171a' }
  };
</script>

<svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
  <rect width="32" height="32" fill={COLORS[shown].tile} />
  <path d={ANVIL} fill={COLORS[shown].anvil} />
</svg>

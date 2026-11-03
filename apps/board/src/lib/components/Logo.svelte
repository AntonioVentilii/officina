<script lang="ts">
  import { look as current } from '$lib/state/look.svelte';
  import type { Look } from '$lib/types';

  interface Props {
    size?: number;
    /** Draws a given look's mark, as the look picker does; otherwise the current one. */
    look?: Look;
  }

  let { size = 28, look }: Props = $props();

  const shown = $derived(look ?? current.current);

  // One anvil for every look; only its colours change: yellow on ink, or ink on highlighter.
  const COLORS: Record<Look, { tile: string; anvil: string }> = {
    modernista: { tile: '#111111', anvil: '#ffd400' },
    tecnica: { tile: '#f2c200', anvil: '#14171a' }
  };
</script>

<svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
  <rect width="32" height="32" fill={COLORS[shown].tile} />
  <path d="M8 13h13l3-3h2v4l-3 2H19v3l3 5H10l3-5v-3H8z" fill={COLORS[shown].anvil} />
</svg>

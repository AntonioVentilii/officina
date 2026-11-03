<script lang="ts">
  import { look as current } from '$lib/state/look.svelte';
  import type { Look } from '$lib/types';

  interface Props {
    size?: number;
    /** Draws a given look's mark, as the look picker does; otherwise the current one. */
    look?: Look;
    /** On a light page the Modernista mark needs its black tile to keep the white circle. */
    tile?: boolean;
  }

  let { size = 28, look, tile = false }: Props = $props();

  const shown = $derived(look ?? current.current);
</script>

{#if shown === 'tecnica'}
  <!-- A drawing's title block: a ruled square, divided, with the last cell highlighted. -->
  <svg viewBox="0 0 26 26" width={size} height={size} aria-hidden="true">
    <rect x="1" y="1" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" />
    <path d="M1 17h24M9 17v8M17 1v16" stroke="currentColor" stroke-width="1.5" />
    <rect x="17.75" y="17.75" width="6.5" height="6.5" fill="var(--accent)" />
  </svg>
{:else if tile}
  <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
    <rect width="32" height="32" fill="#111111" />
    <circle cx="11.5" cy="11.5" r="7.5" fill="#ffffff" />
    <rect x="16" y="16" width="12" height="12" fill="var(--accent)" />
  </svg>
{:else}
  <svg viewBox="0 0 28 28" width={size} height={size} aria-hidden="true">
    <circle cx="9" cy="9" r="9" fill="#ffffff" />
    <rect x="14" y="14" width="14" height="14" fill="var(--accent)" />
  </svg>
{/if}

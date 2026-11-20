<!--
  Something is at work. Modernista draws a ring open on one side that turns; Tecnica a square drawn
  three quarters round whose gap runs along its sides, since a turning square wobbles on its
  corners. Ink, never yellow: yellow means waiting on you, and work in progress waits on nobody.
-->
<script lang="ts">
  import { look } from '#lib/state/look.svelte.ts';
</script>

{#if look.current === 'tecnica'}
  <svg class="loader" viewBox="0 0 12 12" aria-hidden="true">
    <rect x="1" y="1" width="10" height="10" pathLength="100" />
  </svg>
{:else}
  <span class="loader ring" aria-hidden="true"></span>
{/if}

<style>
  .loader {
    flex: none;
    width: var(--loader-size, 13px);
    height: var(--loader-size, 13px);
    overflow: visible;
  }

  .ring {
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  rect {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-dasharray: 75 25;
    animation: run 0.9s linear infinite;
  }

  @keyframes run {
    to {
      stroke-dashoffset: -100;
    }
  }
</style>

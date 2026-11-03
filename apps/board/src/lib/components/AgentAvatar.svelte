<script lang="ts">
  import { look } from '$lib/state/look.svelte';
  import { roleCode, roleShape } from './roles';

  interface Props {
    role: string;
    label?: string;
    running?: boolean;
    size?: number;
  }

  let { role, label, running = false, size = 24 }: Props = $props();

  const shape = $derived(roleShape(role));
</script>

<span
  class="avatar"
  class:running
  style:--size="{size}px"
  style:--s="{Math.round(size * 0.62)}px"
  title={label}
  aria-label={label}
  role="img"
>
  {#if look.current === 'tecnica'}
    <span class="code">{roleCode(role)}</span>
  {:else}
    <span class="shape {shape}"></span>
  {/if}
</span>

<style>
  .avatar {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: var(--size);
    height: var(--size);
    color: currentColor;
  }

  .shape {
    display: block;
    width: var(--s);
    height: var(--s);
    background: currentColor;
  }

  .running .shape,
  .running .code {
    animation: signal 1.2s ease-in-out infinite;
  }

  /* Tecnica: the code sits in a ruled box, so it is as wide as it needs to be. */
  .avatar:has(.code) {
    width: auto;
    min-width: var(--size);
  }

  .code {
    padding: 1px 4px;
    border: 1.5px solid currentColor;
    font-family: var(--font-num);
    font-size: max(10px, calc(var(--size) * 0.42));
    font-weight: 500;
    line-height: 1.2;
    letter-spacing: 0.02em;
  }

  .circle {
    border-radius: 50%;
  }

  .triangle {
    clip-path: polygon(50% 0, 100% 100%, 0 100%);
  }

  .half {
    height: calc(var(--s) / 2);
    border-radius: var(--s) var(--s) 0 0;
  }

  .quarter {
    border-radius: 0 var(--s) 0 0;
  }

  .diamond {
    clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  }

  .ring {
    border: calc(var(--s) * 0.22) solid currentColor;
    border-radius: 50%;
    background: none;
  }

  /* A role this board does not know yet still shows, as an outline. */
  .unknown {
    border: 2px solid currentColor;
    background: none;
  }
</style>

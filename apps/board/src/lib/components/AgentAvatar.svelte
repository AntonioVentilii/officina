<script lang="ts">
  import { roleShape } from './roles';

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
  <span class="shape {shape}"></span>
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

  .running .shape {
    animation: signal 1.2s ease-in-out infinite;
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

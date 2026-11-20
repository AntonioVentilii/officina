<!--
  The status line that takes the place of the buttons while something they started is at work:
  what is being done, who started it and for how long. Nothing to click, so nothing is done twice.
  It opens from the right, where the button that started it was.
-->
<script lang="ts">
  import { duration } from '#lib/format.ts';
  import { clock } from '#lib/state/clock.svelte.ts';
  import type { Work } from '#lib/working.ts';
  import Loader from './Loader.svelte';

  interface Props {
    work: Work;
  }

  let { work }: Props = $props();
</script>

<div class="working" role="status" aria-live="polite">
  <Loader />
  <span class="label">{work.label}</span>
  <span class="detail">{work.detail}</span>
  {#if work.who}<span class="who">{work.who}</span>{/if}
  <span class="elapsed num">{duration(work.since, null, clock.now)}</span>
</div>

<style>
  .working {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    height: 36px;
    padding: 0 12px;
    background: var(--tint);
    border-left: 3px solid var(--rule);
    font-size: 13px;
    animation: open 0.42s var(--ease) 0.08s both;
  }

  /* Only the words fade in: an animation set on the loader would replace its own turning. */
  .label,
  .detail,
  .who,
  .elapsed {
    animation: appear 0.25s 0.32s both;
  }

  .label {
    font-size: 12px;
    font-weight: 800;
    font-stretch: 85%;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .detail {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--text-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .who {
    white-space: nowrap;
  }

  .elapsed {
    color: var(--text-3);
    font-size: 12px;
  }

  :global([data-look='tecnica']) .label {
    font-family: var(--font-display);
    font-size: 12.5px;
    font-weight: 700;
    font-stretch: normal;
  }

  @keyframes open {
    from {
      clip-path: inset(0 0 0 calc(100% - 260px));
      opacity: 0;
    }
    35% {
      opacity: 1;
    }
    to {
      clip-path: inset(0 0 0 0);
      opacity: 1;
    }
  }

  @keyframes appear {
    from {
      opacity: 0;
    }
  }
</style>

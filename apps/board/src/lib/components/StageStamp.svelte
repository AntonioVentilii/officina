<script lang="ts">
  import { untrack } from 'svelte';
  import { HUES } from '#lib/hues.ts';
  import { STAMP_LABELS, stampFor, type Stamp } from '#lib/stages.ts';
  import { look } from '#lib/state/look.svelte.ts';
  import type { Stage } from '#lib/types.ts';

  interface Props {
    number: number;
    stage: Stage;
  }

  let { number, stage }: Props = $props();

  // Fucina stamps a task when people say yes to its plan or its result, and when it ships, for
  // everyone who has it open: the move comes from whoever decided, here or anywhere else.
  let stamp = $state<{ kind: Stamp; at: number } | null>(null);
  let last: { number: number; stage: Stage } | null = null;

  $effect(() => {
    const before = last;
    last = { number, stage };
    if (!before || before.number !== number || untrack(() => look.current) !== 'fucina') return;
    const kind = stampFor(before.stage, stage);
    if (kind) stamp = { kind, at: Date.now() };
  });

  // The stamp is Fucina's: switching look mid-stamp drops it, so it never shows in another look,
  // nor plays again on coming back.
  $effect(() => {
    if (look.current !== 'fucina') stamp = null;
  });

  const ANVIL = 'M8 13h13l3-3h2v4l-3 2H19v3l3 5H10l3-5v-3H8z';
  const RAYS = Array.from({ length: 10 }, (_, index) => index * 36);
  // Confetti in every hue of the palette, thrown on a golden-angle spiral so no two pieces meet.
  const COLORS = Object.values(HUES);
  const CONFETTI = Array.from({ length: 24 }, (_, index) => {
    const angle = (index * 137.5 * Math.PI) / 180;
    const reach = 80 + (index % 5) * 30;
    return {
      x: Math.round(Math.cos(angle) * reach),
      y: Math.round(Math.sin(angle) * reach * 0.8 + 60),
      turn: (index * 47) % 360,
      color: COLORS[index % COLORS.length]
    };
  });
</script>

{#if stamp && look.current === 'fucina'}
  {#key stamp.at}
    <div class="stamp" style:--stamp={HUES.green} aria-hidden="true">
      <svg class="seal" viewBox="0 0 150 150" onanimationend={() => (stamp = null)}>
        <circle class="disc" cx="75" cy="75" r="66" />
        <circle class="ring" cx="75" cy="75" r="56" />
        <path transform="translate(43 38) scale(2)" d={ANVIL} />
        <text x="75" y="118" text-anchor="middle">{STAMP_LABELS[stamp.kind].toUpperCase()}</text>
      </svg>
      {#each RAYS as turn (turn)}
        <i class="ray" style:--turn="{turn}deg"></i>
      {/each}
      {#if stamp.kind === 'shipped'}
        {#each CONFETTI as piece, index (index)}
          <i
            class="piece"
            style:--x="{piece.x}px"
            style:--y="{piece.y}px"
            style:--turn="{piece.turn}deg"
            style:background={piece.color}
          ></i>
        {/each}
      {/if}
    </div>
  {/key}
{/if}

<style>
  .stamp {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: grid;
    place-items: center;
    pointer-events: none;
  }

  .stamp > * {
    grid-area: 1 / 1;
  }

  .seal {
    width: 150px;
    height: 150px;
    opacity: 0;
    animation: slam 1.9s cubic-bezier(0.5, 0, 0.2, 1.3) forwards;
  }

  .disc {
    fill: color-mix(in srgb, var(--stamp) 14%, var(--panel));
    stroke: var(--stamp);
    stroke-width: 5;
  }

  .ring {
    fill: none;
    stroke: var(--stamp);
    stroke-width: 1.5;
    stroke-dasharray: 4 4;
  }

  .seal path,
  .seal text {
    fill: var(--stamp);
  }

  .seal text {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 800;
    letter-spacing: 0.14em;
  }

  .ray {
    width: 3px;
    height: 12px;
    border-radius: 2px;
    background: var(--stamp);
    opacity: 0;
    animation: ray 0.8s 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  }

  .piece {
    width: 7px;
    height: 10px;
    border-radius: 2px;
    opacity: 0;
    animation: throw 1.5s 0.3s cubic-bezier(0.2, 0.7, 0.4, 1) forwards;
  }

  @keyframes slam {
    0% {
      opacity: 0;
      transform: scale(2.4) rotate(-20deg);
    }
    18% {
      opacity: 1;
      transform: scale(0.94) rotate(-9deg);
    }
    24%,
    80% {
      opacity: 1;
      transform: scale(1) rotate(-8deg);
    }
    100% {
      opacity: 0;
      transform: scale(1.05) rotate(-8deg);
    }
  }

  @keyframes ray {
    0% {
      opacity: 1;
      transform: rotate(var(--turn)) translateY(-70px) scaleY(0.4);
    }
    100% {
      opacity: 0;
      transform: rotate(var(--turn)) translateY(-104px) scaleY(1);
    }
  }

  @keyframes throw {
    0% {
      opacity: 1;
      transform: translate(0, 0) rotate(0);
    }
    100% {
      opacity: 0;
      transform: translate(var(--x), var(--y)) rotate(calc(var(--turn) * 2));
    }
  }
</style>

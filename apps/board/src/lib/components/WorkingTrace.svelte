<!--
  A stretch of ink running round the whole frame of something at work, at an even pace. Its parent
  is positioned and sets `--frame` to its border width, so the trace runs on that border.
-->
<svg class="trace" aria-hidden="true">
  <rect x="0" y="0" width="100%" height="100%" pathLength="100" />
</svg>

<style>
  .trace {
    position: absolute;
    left: calc(-1 * var(--frame, 1.5px));
    top: calc(-1 * var(--frame, 1.5px));
    width: calc(100% + 2 * var(--frame, 1.5px));
    height: calc(100% + 2 * var(--frame, 1.5px));
    overflow: visible;
    pointer-events: none;
    animation: appear 0.4s 0.15s both;
  }

  rect {
    fill: none;
    stroke: var(--rule);
    stroke-width: calc(var(--frame, 1.5px) + 1px);
    stroke-dasharray: 12 88;
    animation: run 2.4s linear infinite;
  }

  @keyframes run {
    to {
      stroke-dashoffset: -100;
    }
  }

  @keyframes appear {
    from {
      opacity: 0;
    }
  }
</style>

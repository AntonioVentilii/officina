<script lang="ts">
  import './agent-mark.css';
  import { roleHue } from './roles';

  interface Props {
    role: string;
    running?: boolean;
  }

  let { role, running = false }: Props = $props();

  // The anvil is the logo's (static/favicon.svg), placed where the hammer lands.
  const ANVIL = 'M8 13h13l3-3h2v4l-3 2H19v3l3 5H10l3-5v-3H8z';
</script>

<!-- Fucina's mark: a small drawing of what the role does, on a 48 unit grid. Only a running agent
     moves; each drawing stands still otherwise, and under reduced motion. -->
<span class="agent-mark" class:run={running} style:--hue={roleHue(role)}>
  <svg viewBox="0 0 48 48" aria-hidden="true">
    {#if role === 'interviewer'}
      <path
        class="i"
        d="M9 9h30a5 5 0 0 1 5 5v15a5 5 0 0 1-5 5H23l-9 7v-7H9a5 5 0 0 1-5-5V14a5 5 0 0 1 5-5z"
      />
      <circle class="a dot" cx="15" cy="21.5" r="3" />
      <circle class="a dot" style:--delay="0.15s" cx="24" cy="21.5" r="3" />
      <circle class="a dot" style:--delay="0.3s" cx="33" cy="21.5" r="3" />
    {:else if role === 'spec'}
      <path class="i" d="M10 4h21l9 9v31H10z" />
      <path class="soft" d="M31 4v9h9z" />
      <line class="sa line" x1="16" y1="18" x2="34" y2="18" />
      <line class="sa line" style:--delay="0.3s" x1="16" y1="25" x2="34" y2="25" />
      <line class="sa line" style:--delay="0.6s" x1="16" y1="32" x2="34" y2="32" />
      <line class="sa line" style:--delay="0.9s" x1="16" y1="39" x2="27" y2="39" />
    {:else if role === 'builder'}
      <path class="i anvil" transform="translate(-3 13) scale(1.15)" d={ANVIL} />
      <path class="sa spark" d="M8 27l-5-5M18 27l5-5M7 29.5H1M19 29.5h6" />
      <g class="hammer">
        <path class="i" d="M16 16.6h22.5a2.2 2.2 0 0 1 0 4.4H16z" />
        <path class="a" d="M9.5 20h7v8h-7zM10.5 20l1-9h3l1 9z" />
      </g>
    {:else if role === 'reviewer_spec'}
      <path class="i" d="M8 4h26v40H8z" />
      <g class="lens">
        <circle class="soft" cx="22" cy="20" r="8" />
        <circle class="sa" cx="22" cy="20" r="8" />
        <line class="sa handle" x1="28" y1="26" x2="35" y2="33" />
      </g>
    {:else if role === 'reviewer_correctness'}
      <rect class="i" x="5" y="7" width="10" height="10" />
      <rect class="i" x="5" y="20" width="10" height="10" />
      <rect class="i" x="5" y="33" width="10" height="10" />
      <path class="si faint" d="M20 12h22M20 25h22M20 38h16" />
      <path class="sa tick" d="M3 11l5 5 9-12" />
      <path class="sa tick" style:--delay="0.4s" d="M3 24l5 5 9-12" />
      <path class="sa tick" style:--delay="0.8s" d="M3 37l5 5 9-12" />
    {:else if role === 'chooser'}
      <path class="i" d="M22 14h4v26h-4zM14 40h20v4H14z" />
      <g class="beam">
        <rect class="i" x="6" y="12" width="36" height="4" rx="2" />
        <path class="i" d="M24 6l4 6h-8z" />
        <g class="pan left">
          <path class="si cord" d="M4 28l6-14 6 14" />
          <path class="a" d="M2 28h16a8 6 0 0 1-16 0z" />
        </g>
        <g class="pan right">
          <path class="si cord" d="M32 28l6-14 6 14" />
          <path class="a" d="M30 28h16a8 6 0 0 1-16 0z" />
        </g>
      </g>
    {:else if role === 'learner'}
      <path class="sa rays" d="M24 2v4M7 9l3 3M41 9l-3 3M2 22h4M42 22h4" />
      <circle class="i" cx="24" cy="21" r="12" />
      <circle class="a glow" cx="24" cy="21" r="7" />
      <path class="i" d="M18 32h12v6H18zM20 40h8v3h-8z" />
    {:else if role === 'onboarder'}
      <path class="i" d="M4 4h40v40H4zM9 9v30h30V9z" fill-rule="evenodd" />
      <rect class="a block" x="12" y="27" width="11" height="9" />
      <rect class="a block" style:--delay="0.35s" x="25" y="27" width="11" height="9" />
      <rect class="a block" style:--delay="0.7s" x="18" y="16" width="12" height="9" />
    {:else}
      <!-- A role this board does not know yet still shows, as an outline. -->
      <rect class="si" x="8" y="8" width="32" height="32" />
    {/if}
  </svg>
</span>

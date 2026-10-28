<script lang="ts">
  import { CircleHelp, GitPullRequest, Pause, UserRound } from '@lucide/svelte';
  import { money, since } from '$lib/format';
  import { STAGE_LABELS } from '$lib/stages';
  import { session } from '$lib/state/session.svelte';
  import type { Card } from '$lib/types';
  import AgentAvatar from './AgentAvatar.svelte';
  import LaneChip from './LaneChip.svelte';
  import MemberAvatar from './MemberAvatar.svelte';
  import { roleColor } from './roles';

  interface Props {
    card: Card;
    repo: string | null;
    now: number;
    active?: boolean;
  }

  let { card, repo, now, active = false }: Props = $props();

  const working = $derived(card.running.length > 0);
  const hue = $derived(roleColor(card.running[0]?.role ?? 'builder'));
</script>

<a
  class="card"
  class:mine={card.waitingOn.me}
  class:blocked={card.blocked}
  class:working
  class:active
  style:--hue={hue}
  href="/tasks/{card.number}"
  data-sveltekit-noscroll
>
  <div class="top">
    <span class="number mono">#{card.number}</span>
    <LaneChip lane={card.lane} />
    <span class="stage">{STAGE_LABELS[card.stage]}</span>
  </div>

  <h3 class="title">{card.title}</h3>

  <div class="waiting {card.waitingOn.kind}">
    {#if card.blocked}
      <span class="icon question"><CircleHelp size={14} /></span>
      <span class="label">{card.waitingOn.me ? 'Your answer needed' : card.waitingOn.label}</span>
    {:else if card.paused}
      <span class="icon"><Pause size={14} /></span>
      <span class="label">Paused</span>
    {:else if working}
      <span class="agents">
        {#each card.running as agent (agent.role)}
          <AgentAvatar role={agent.role} label={agent.label} running size={22} />
        {/each}
      </span>
      <span class="label">{card.waitingOn.label}</span>
    {:else if card.waitingOn.me}
      <span class="you">Your turn</span>
      <span class="label">{card.waitingOn.label}</span>
    {:else if card.waitingOn.kind === 'people'}
      <span class="icon"><UserRound size={14} /></span>
      <span class="label">{card.waitingOn.label}</span>
    {:else if card.waitingOn.kind !== 'nobody'}
      <span class="label faint">{card.waitingOn.label}</span>
    {/if}
  </div>

  <div class="meta">
    <MemberAvatar name={card.requester} size={18} />
    <span class="faint num" title="Time in this stage">{since(card.stageSince, now)}</span>
    {#if session.technical && card.costCents > 0}<span class="faint num" title="Agent cost so far"
        >{money(card.costCents)}</span
      >{/if}
    <span class="spacer"></span>
    {#if session.technical && card.pullRequest && repo}
      <span class="pr num" title="Pull request on GitHub"
        ><GitPullRequest size={12} />{card.pullRequest}</span
      >
    {/if}
  </div>
</a>

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 11px 12px 10px;
    border-radius: var(--radius);
    background: var(--panel);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    transition:
      border-color 0.15s,
      transform 0.15s var(--ease),
      background 0.15s;
    isolation: isolate;
  }

  .card:hover {
    border-color: var(--border-strong);
    transform: translateY(-1px);
  }

  .card.active {
    border-color: var(--accent);
  }

  .card.mine {
    border-color: color-mix(in srgb, var(--accent) 38%, var(--border));
    box-shadow:
      inset 3px 0 0 var(--accent),
      var(--shadow);
  }

  .card.blocked {
    border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
    box-shadow:
      inset 3px 0 0 var(--danger),
      var(--shadow);
  }

  /* A running agent draws a light that orbits the card's border in its role colour. */
  .card.working::before {
    content: '';
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    padding: 1px;
    background: conic-gradient(
      from var(--angle),
      transparent 0 62%,
      color-mix(in srgb, var(--hue) 90%, transparent) 82%,
      transparent 100%
    );
    -webkit-mask:
      linear-gradient(#000 0 0) content-box,
      linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    mask:
      linear-gradient(#000 0 0) content-box exclude,
      linear-gradient(#000 0 0);
    animation: orbit 3.2s linear infinite;
    pointer-events: none;
    z-index: -1;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .number {
    font-size: 11.5px;
    color: var(--text-3);
  }

  .stage {
    font-size: 11.5px;
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .title {
    margin: 0;
    font-size: 13.5px;
    font-weight: 560;
    line-height: 1.4;
    letter-spacing: -0.005em;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .waiting {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 22px;
    font-size: 12px;
    color: var(--text-2);
  }

  .waiting .label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .agents {
    display: inline-flex;
    gap: 4px;
  }

  .icon {
    display: inline-grid;
    place-items: center;
    color: var(--text-3);
  }

  .question {
    color: var(--danger);
  }

  .blocked .waiting {
    color: var(--danger);
  }

  .you {
    flex: none;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 650;
    color: var(--accent-text);
    background: var(--accent);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }

  .spacer {
    flex: 1;
  }

  .pr {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--text-2);
  }
</style>

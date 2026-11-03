<script lang="ts">
  import { CircleHelp, Pause, UserRound } from '@lucide/svelte';
  import { initials, money, since } from '$lib/format';
  import { STAGE_LABELS } from '$lib/stages';
  import { session } from '$lib/state/session.svelte';
  import type { Card } from '$lib/types';
  import AgentAvatar from './AgentAvatar.svelte';
  import LaneChip from './LaneChip.svelte';

  interface Props {
    card: Card;
    repo: string | null;
    now: number;
    active?: boolean;
  }

  let { card, repo, now, active = false }: Props = $props();

  const working = $derived(card.running.length > 0);
</script>

<a class="card" class:active href="/tasks/{card.number}" data-sveltekit-noscroll>
  <div class="top caps">
    <span class="number num">#{card.number}</span>
    <span class="stage">{STAGE_LABELS[card.stage]}</span>
    <span class="lane"><LaneChip lane={card.lane} /></span>
  </div>

  <h3 class="title">{card.title}</h3>

  {#if card.blocked && card.waitingOn.me}
    <div class="you"><strong>You</strong><span>answer the question</span></div>
  {:else if card.blocked}
    <div class="waiting"><CircleHelp size={14} /><span>{card.waitingOn.label}</span></div>
  {:else if card.paused}
    <div class="waiting"><Pause size={14} /><span>Paused</span></div>
  {:else if working}
    <div class="waiting">
      <span class="agents">
        {#each card.running as agent (agent.role)}
          <AgentAvatar role={agent.role} label={agent.label} running size={18} />
        {/each}
      </span>
      <span>{card.waitingOn.label}</span>
    </div>
  {:else if card.waitingOn.me}
    <div class="you"><strong>You</strong><span>{card.waitingOn.label}</span></div>
  {:else if card.waitingOn.kind === 'people'}
    <div class="waiting"><UserRound size={14} /><span>{card.waitingOn.label}</span></div>
  {:else if card.waitingOn.kind !== 'nobody'}
    <div class="waiting faint"><span>{card.waitingOn.label}</span></div>
  {/if}

  <div class="meta">
    <span class="who" title={card.requester}>{initials(card.requester)}</span>
    <span class="num" title="Time in this stage">{since(card.stageSince, now)}</span>
    {#if card.costCents}<span class="num" title="Agent cost so far">{money(card.costCents)}</span
      >{/if}
    {#if session.technical && card.pullRequest && repo}
      <span class="pr num" title="Pull request on GitHub">PR {card.pullRequest}</span>
    {/if}
  </div>
</a>

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 18px;
    border-bottom: 1px solid var(--border);
    transition: background 0.15s;
  }

  .card:hover {
    background: var(--hover);
  }

  .card.active {
    background: var(--tint);
  }

  .card.active::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 4px;
    background: var(--rule);
  }

  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: var(--text-2);
  }

  .number {
    color: var(--text);
    font-weight: 700;
  }

  .stage {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .lane {
    display: inline-flex;
    margin-left: auto;
    color: var(--text);
  }

  .title {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    line-height: 1.22;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .you {
    align-self: flex-start;
  }

  .waiting {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-size: 13px;
    color: var(--text-2);
  }

  .waiting > :global(svg) {
    flex: none;
    color: var(--text);
  }

  .waiting span:last-child {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .agents {
    display: inline-flex;
    flex: none;
    color: var(--text);
  }

  .meta {
    display: flex;
    gap: 14px;
    font-size: 12px;
    font-stretch: 85%;
    letter-spacing: 0.04em;
    color: var(--text-2);
  }

  .who {
    color: var(--text);
    font-weight: 700;
  }

  .pr {
    margin-left: auto;
  }
</style>

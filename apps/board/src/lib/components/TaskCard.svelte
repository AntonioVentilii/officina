<script lang="ts">
  import { CircleHelp, Pause, UserRound } from '@lucide/svelte';
  import { initials, money, since } from '$lib/format';
  import { STAGE_LABELS } from '$lib/stages';
  import { look } from '$lib/state/look.svelte';
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
  const tecnica = $derived(look.current === 'tecnica');
</script>

<a
  class="card"
  class:active
  class:sensitive={card.lane === 'red'}
  href="/tasks/{card.number}"
  data-sveltekit-noscroll
>
  <span class="band" aria-hidden="true"></span>
  <div class="top caps">
    <span class="number num">#{card.number}</span>
    <span class="stage">{STAGE_LABELS[card.stage]}</span>
    <span class="lane"><LaneChip lane={card.lane} /></span>
  </div>

  <h3 class="title">{card.title}</h3>

  {#if card.blocked && card.waitingOn.me}
    <div class="you">
      {#if tecnica}<strong>Question</strong><span>Your answer is needed</span>{:else}<strong
          >You</strong
        ><span>answer the question</span>{/if}
    </div>
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
    <div class="you">
      <strong>{tecnica ? 'Your turn' : 'You'}</strong><span>{card.waitingOn.label}</span>
    </div>
  {:else if card.waitingOn.kind === 'people'}
    <div class="waiting"><UserRound size={14} /><span>{card.waitingOn.label}</span></div>
  {:else if card.waitingOn.kind !== 'nobody'}
    <div class="waiting faint"><span>{card.waitingOn.label}</span></div>
  {/if}

  <div class="meta">
    <span class="who" title={card.requester}>{initials(card.requester)}</span>
    <span class="num" title="Time in this stage">{since(card.stageSince, now)}</span>
    <!-- Cells stay even when empty, so Tecnica's title block keeps its grid. -->
    <span class="num" title="Agent cost so far">{card.costCents ? money(card.costCents) : ''}</span>
    <span class="pr num" title="Pull request on GitHub"
      >{session.technical && card.pullRequest && repo ? `PR ${card.pullRequest}` : ''}</span
    >
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

  .meta > :empty,
  .band {
    display: none;
  }

  /* Tecnica: a work order, a ruled box with a title block of cells along its foot. */
  :global([data-look='tecnica']) .card {
    gap: 0;
    padding: 0;
    border: 1.5px solid var(--rule);
    background: var(--panel);
  }

  :global([data-look='tecnica']) .card:hover {
    background: var(--panel);
    outline: 1.5px solid var(--rule);
  }

  :global([data-look='tecnica']) .card.active {
    outline: 3px solid var(--rule);
    outline-offset: 0;
  }

  :global([data-look='tecnica']) .card.active::before {
    content: none;
  }

  :global([data-look='tecnica']) .card.sensitive {
    border-color: var(--danger);
  }

  :global([data-look='tecnica']) .sensitive .band {
    display: block;
    height: 8px;
    border-bottom: 1.5px solid var(--danger);
    background: repeating-linear-gradient(45deg, var(--danger) 0 1.5px, transparent 1.5px 5px);
  }

  :global([data-look='tecnica']) .top {
    padding: 12px 14px 0;
    letter-spacing: 0.02em;
  }

  :global([data-look='tecnica']) .number {
    font-weight: 400;
  }

  :global([data-look='tecnica']) .title {
    padding: 8px 14px 0;
    font-size: 15px;
    font-weight: 500;
    line-height: 1.3;
  }

  :global([data-look='tecnica']) .you,
  :global([data-look='tecnica']) .waiting {
    margin: 8px 14px 0;
    font-size: 12.5px;
  }

  :global([data-look='tecnica']) .meta {
    display: grid;
    grid-template-columns: 34px minmax(0, 0.8fr) minmax(0, 1fr) minmax(0, 1.25fr);
    gap: 0;
    margin-top: 12px;
    border-top: 1px solid var(--rule);
    font-size: 11.5px;
    font-stretch: normal;
    letter-spacing: 0;
    color: var(--text);
  }

  :global([data-look='tecnica']) .sensitive .meta {
    border-top-color: var(--danger);
  }

  :global([data-look='tecnica']) .meta > * {
    display: block;
    min-height: 26px;
    margin: 0;
    padding: 5px 6px;
    border-left: 1px solid var(--border);
    font-family: var(--font-num);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :global([data-look='tecnica']) .meta > .who {
    padding: 5px 0;
    border-left: 0;
    text-align: center;
    font-weight: 400;
  }
</style>

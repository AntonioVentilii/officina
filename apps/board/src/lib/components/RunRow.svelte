<script lang="ts">
  import { ChevronRight, ExternalLink } from '@lucide/svelte';
  import { duration, money } from '$lib/format';
  import { STAGE_LABELS } from '$lib/stages';
  import { clock } from '$lib/state/clock.svelte';
  import type { Run, Stage } from '$lib/types';
  import AgentAvatar from './AgentAvatar.svelte';
  import RunLog from './RunLog.svelte';
  import { roleColor } from './roles';

  interface Props {
    run: Run;
    open?: boolean;
    showTask?: boolean;
  }

  let { run, open = $bindable(false), showTask = false }: Props = $props();

  const running = $derived(run.status === 'running' || run.status === 'queued');

  const STATUS = {
    queued: { label: 'Queued', tone: 'info' },
    running: { label: 'Running', tone: 'accent' },
    succeeded: { label: 'Done', tone: 'ok' },
    failed: { label: 'Failed', tone: 'danger' },
    cancelled: { label: 'Cancelled', tone: '' }
  } as const;
</script>

<div class="run" class:open class:running style:--hue={roleColor(run.role)}>
  <button class="head" onclick={() => (open = !open)} aria-expanded={open}>
    <ChevronRight size={14} class="chev" />
    <AgentAvatar role={run.role} label={run.label} {running} size={26} />
    <span class="what">
      <span class="title">
        {run.label}
        {#if showTask}<span class="faint">on</span>
          <span class="task">#{run.taskNumber} {run.taskTitle}</span>{/if}
      </span>
      <span class="sub faint">
        {STAGE_LABELS[run.stage as Stage] ?? run.stage} · v{run.agentVersion}
      </span>
    </span>
    <span class="pill {STATUS[run.status].tone}">
      {#if running}<span class="dot"></span>{/if}{STATUS[run.status].label}
    </span>
    <span class="time faint num">{duration(run.startedAt, run.finishedAt, clock.now)}</span>
    <span class="cost faint num">{money(run.costCents)}</span>
    {#if run.consoleUrl}
      <a
        class="console btn ghost icon sm"
        href={run.consoleUrl}
        target="_blank"
        rel="noopener noreferrer"
        title="Open the session in the Claude Console"
        onclick={(event) => event.stopPropagation()}
      >
        <ExternalLink size={13} />
      </a>
    {/if}
  </button>
  {#if open}
    <RunLog {run} />
  {/if}
</div>

<style>
  .run {
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--panel);
    overflow: hidden;
  }

  .run.running {
    border-color: color-mix(in srgb, var(--hue) 45%, var(--border));
  }

  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 10px 9px 8px;
    border: 0;
    background: none;
    text-align: left;
  }

  .head:hover {
    background: var(--hover);
  }

  .head :global(.chev) {
    flex: none;
    color: var(--text-3);
    transition: transform 0.15s;
  }

  .open .head :global(.chev) {
    transform: rotate(90deg);
  }

  .what {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    line-height: 1.3;
  }

  .title {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task {
    font-weight: 500;
  }

  .sub {
    font-size: 11.5px;
  }

  .pill .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 1.2s ease-in-out infinite;
  }

  .time,
  .cost {
    font-size: 12px;
    min-width: 52px;
    text-align: right;
  }

  @media (max-width: 640px) {
    .cost,
    .sub {
      display: none;
    }
  }
</style>

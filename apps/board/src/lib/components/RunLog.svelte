<script lang="ts">
  import { ChevronRight, CircleAlert, CircleCheck, GitPullRequest, Undo2 } from '@lucide/svelte';
  import { tick } from 'svelte';
  import { get } from '$lib/api';
  import { coalesce, live } from '$lib/state/live.svelte';
  import type { LogEntry, Run } from '$lib/types';
  import Markdown from './Markdown.svelte';

  interface Props {
    run: Run;
  }

  let { run }: Props = $props();

  let entries = $state<LogEntry[]>([]);
  let cursor = $state('0');
  let loaded = $state(false);
  let scroller: HTMLDivElement | undefined = $state();
  let follow = $state(true);

  const running = $derived(run.status === 'running' || run.status === 'queued');

  type Block =
    | { kind: 'brief' | 'message' | 'feedback' | 'error'; id: string; text: string }
    | { kind: 'thinking'; id: string; count: number }
    | {
        kind: 'tool';
        id: string;
        name: string;
        summary: string;
        result: { text: string; isError: boolean } | null;
      }
    | { kind: 'submitted'; id: string; outcome: string }
    | { kind: 'officina'; id: string; type: string; payload: unknown };

  // Tool calls absorb the result that follows them, and runs of thinking collapse into one row.
  const blocks = $derived.by(() => {
    const out: Block[] = [];
    for (const entry of entries) {
      const last = out.at(-1);
      switch (entry.kind) {
        case 'thinking':
          if (last?.kind === 'thinking') last.count++;
          else out.push({ kind: 'thinking', id: entry.id, count: 1 });
          break;
        case 'tool':
          out.push({
            kind: 'tool',
            id: entry.id,
            name: entry.name,
            summary: entry.summary,
            result: null
          });
          break;
        case 'tool_result': {
          const open = [...out].reverse().find((block) => block.kind === 'tool' && !block.result);
          if (open?.kind === 'tool') open.result = { text: entry.text, isError: entry.isError };
          break;
        }
        case 'status':
          break;
        case 'message':
        case 'brief':
        case 'feedback':
        case 'error':
          out.push({ kind: entry.kind, id: entry.id, text: entry.text });
          break;
        case 'submitted':
          out.push({ kind: 'submitted', id: entry.id, outcome: entry.outcome });
          break;
        case 'officina':
          out.push({ kind: 'officina', id: entry.id, type: entry.type, payload: entry.payload });
          break;
      }
    }
    return out;
  });

  const load = async () => {
    const page = await get<{ entries: LogEntry[]; cursor: string }>(
      `/api/runs/${run.id}/log?after=${cursor}`
    );
    if (page.entries.length) entries = [...entries, ...page.entries];
    cursor = page.cursor;
    loaded = true;
    if (follow) {
      await tick();
      scroller?.scrollTo({
        top: scroller.scrollHeight,
        behavior: entries.length > page.entries.length ? 'smooth' : 'auto'
      });
    }
    // A page is capped server-side; keep reading until caught up.
    if (page.entries.length >= 400) void load();
  };

  const loadSoon = coalesce(() => void load(), 300);

  $effect(() => {
    void load();
    return live.subscribe((event) => {
      if (event.kind === 'run' && event.runId === run.id) loadSoon();
    });
  });

  const onScroll = () => {
    if (!scroller) return;
    follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  };

  const lines = (text: string) => text.split('\n').length;
  const prNumber = (payload: unknown) => (payload as { number?: number }).number;
  const prUrl = (payload: unknown) => (payload as { url?: string }).url;
</script>

<div class="log" bind:this={scroller} onscroll={onScroll}>
  {#if !loaded}
    <div class="skeleton"></div>
    <div class="skeleton short"></div>
  {:else if blocks.length === 0}
    <p class="faint empty">{running ? 'Starting the session…' : 'No log for this run.'}</p>
  {/if}

  {#each blocks as block (block.id)}
    {#if block.kind === 'brief'}
      <details class="brief">
        <summary
          ><ChevronRight size={13} class="chev" />Brief from Officina
          <span class="faint">· {lines(block.text)} lines</span></summary
        >
        <pre>{block.text}</pre>
      </details>
    {:else if block.kind === 'message'}
      <div class="message"><Markdown source={block.text} /></div>
    {:else if block.kind === 'thinking'}
      <div class="thinking">Thought{block.count > 1 ? ` ×${block.count}` : ''}</div>
    {:else if block.kind === 'tool'}
      <details class="tool" class:error={block.result?.isError}>
        <summary>
          <ChevronRight size={13} class="chev" />
          <span class="name mono">{block.name}</span>
          <span class="summary mono">{block.summary}</span>
          {#if !block.result}<span class="spinner" aria-label="Running"></span>{/if}
        </summary>
        {#if block.result}
          <pre class="output">{block.result.text || '(no output)'}</pre>
        {/if}
      </details>
    {:else if block.kind === 'submitted'}
      <div class="event ok">
        <CircleCheck size={14} />Submitted its result: <strong>{block.outcome}</strong>
      </div>
    {:else if block.kind === 'feedback'}
      <div class="event warn">
        <Undo2 size={14} /><span>Officina sent the result back: {block.text}</span>
      </div>
    {:else if block.kind === 'error'}
      <div class="event danger"><CircleAlert size={14} /><span>{block.text}</span></div>
    {:else if block.kind === 'officina' && block.type === 'pull_request_opened'}
      <a class="event info" href={prUrl(block.payload)} target="_blank" rel="noopener noreferrer">
        <GitPullRequest size={14} />Officina opened pull request #{prNumber(block.payload)}
      </a>
    {/if}
  {/each}

  {#if running && loaded}
    <div class="working"><span class="bar"></span>Working</div>
  {/if}
</div>

<style>
  .log {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 520px;
    overflow-y: auto;
    padding: 12px 14px 14px 18px;
    border-top: 1px solid var(--border);
    background: var(--code-bg);
    border-left: 2px solid color-mix(in srgb, var(--hue) 55%, transparent);
  }

  .empty {
    margin: 4px 0;
    font-size: 12.5px;
  }

  .skeleton {
    height: 14px;
    border-radius: 4px;
    background: linear-gradient(90deg, var(--panel-2), var(--panel-3), var(--panel-2));
    background-size: 200% 100%;
    animation: shimmer 1.4s linear infinite;
  }

  .skeleton.short {
    width: 60%;
  }

  summary {
    display: flex;
    align-items: center;
    gap: 7px;
    cursor: pointer;
    list-style: none;
    min-width: 0;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary :global(.chev) {
    flex: none;
    color: var(--text-3);
    transition: transform 0.15s;
  }

  details[open] > summary :global(.chev) {
    transform: rotate(90deg);
  }

  .brief summary {
    font-size: 12px;
    color: var(--text-2);
  }

  pre {
    margin: 6px 0 2px 20px;
    padding: 10px 12px;
    max-height: 300px;
    overflow: auto;
    border-radius: var(--radius-sm);
    background: var(--panel);
    border: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-2);
  }

  .message {
    padding: 6px 0 4px;
  }

  .message :global(.md) {
    font-size: 13.5px;
  }

  .thinking {
    font-size: 12px;
    font-style: italic;
    color: var(--text-3);
    padding-left: 20px;
  }

  .tool summary {
    height: 26px;
    font-size: 12px;
  }

  .tool .name {
    flex: none;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--hue);
    background: color-mix(in srgb, var(--hue) 12%, transparent);
  }

  .tool .summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }

  .tool.error .name {
    color: var(--danger);
    background: var(--danger-soft);
  }

  .tool.error .output {
    color: var(--danger);
  }

  .spinner {
    flex: none;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 1.5px solid var(--border-strong);
    border-top-color: var(--hue);
    animation: spin 0.7s linear infinite;
  }

  .event {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    padding: 7px 10px;
    border-radius: var(--radius-sm);
    font-size: 12.5px;
  }

  .event :global(svg) {
    flex: none;
    margin-top: 2px;
  }

  .event.ok {
    color: var(--ok);
    background: var(--ok-soft);
  }

  .event.warn {
    color: var(--warn);
    background: var(--warn-soft);
  }

  .event.danger {
    color: var(--danger);
    background: var(--danger-soft);
  }

  .event.info {
    color: var(--info);
    background: var(--info-soft);
  }

  .working {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0 0 20px;
    font-size: 12px;
    color: var(--text-3);
  }

  .bar {
    width: 38px;
    height: 3px;
    border-radius: 2px;
    background: linear-gradient(90deg, transparent, var(--hue), transparent);
    background-size: 200% 100%;
    animation: shimmer 1.2s linear infinite;
  }
</style>

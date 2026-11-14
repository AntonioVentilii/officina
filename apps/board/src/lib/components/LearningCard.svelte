<script lang="ts">
  import { Bot, Check, ExternalLink, FileText, GitPullRequest, X } from '@lucide/svelte';
  import { post } from '$lib/api';
  import { editLines } from '$lib/diff';
  import { ago } from '$lib/format';
  import { board } from '$lib/state/board.svelte';
  import { clock } from '$lib/state/clock.svelte';
  import { session } from '$lib/state/session.svelte';
  import { toasts } from '$lib/state/toasts.svelte';
  import type { Learning } from '$lib/types';
  import AgentAvatar from './AgentAvatar.svelte';

  interface Props {
    learning: Learning;
    compact?: boolean;
  }

  let { learning, compact = false }: Props = $props();

  const TARGET_LABELS = {
    docs: 'agent docs',
    project: 'project docs',
    agent: 'Officina agent prompt'
  } as const;

  // Only edits to Officina's own prompts stay on the board; the others land as a pull request.
  const opensPullRequest = $derived(learning.target !== 'agent');

  let rejecting = $state(false);
  let note = $state('');
  let busy = $state(false);

  // The diff people approve is exactly what lands; lines the edit keeps show as context.
  const lines = $derived(editLines(learning.find, learning.text));

  const decide = async (decision: 'accept' | 'reject') => {
    if (!session.projectId) return;
    busy = true;
    try {
      const { rewriting } = await post<{ rewriting: boolean }>(
        `/api/projects/${session.projectId}/learnings/${learning.id}`,
        {
          decision,
          // The edit shown here: one rewritten since is never accepted unseen.
          rewrittenAt: learning.rewrittenAt,
          ...(note.trim() ? { note: note.trim() } : {})
        }
      );
      toasts.show(
        'ok',
        decision === 'reject'
          ? 'Learning rejected'
          : rewriting
            ? 'The file changed since: the learner is rewriting the edit, check it again when it is back'
            : opensPullRequest
              ? 'Accepted: pull request opened'
              : 'Accepted for the Officina prompts'
      );
      rejecting = false;
      await board.refresh();
    } catch (error) {
      toasts.show('error', (error as Error).message);
    } finally {
      busy = false;
    }
  };

  const STATUS = {
    proposed: { label: 'Proposed', tone: 'accent' },
    accepted: { label: 'Accepted', tone: 'info' },
    applied: { label: 'Applied', tone: 'ok' },
    rejected: { label: 'Rejected', tone: '' }
  } as const;
</script>

<article class="learning {learning.status}">
  <header>
    <AgentAvatar role="learner" label={board.roleLabel('learner')} size={26} />
    <div class="grow">
      <h3>{learning.title}</h3>
      <div class="meta">
        {#if learning.taskNumber && !compact}
          from <a href="/tasks/{learning.taskNumber}">task {learning.taskNumber}</a> ·
        {/if}
        {ago(learning.createdAt, clock.now)}
        {#if learning.rewrittenAt}
          · edit rewritten {ago(learning.rewrittenAt, clock.now)}
        {/if}
      </div>
    </div>
    <span class="pill {STATUS[learning.status].tone}">{STATUS[learning.status].label}</span>
  </header>

  <p class="lesson">{learning.lesson}</p>

  <details class="evidence">
    <summary class="caps">Evidence</summary>
    <p>{learning.evidence}</p>
  </details>

  <div class="change">
    <div class="file">
      {#if opensPullRequest}<FileText size={13} />{:else}<Bot size={13} />{/if}
      <span class="mono">{learning.file}</span>
      <span class="caps faint">
        {TARGET_LABELS[learning.target]} ·
        {learning.find ? 'replace' : 'append at the end'}
      </span>
    </div>
    <pre class="diff">{#each lines as line, index (index)}<span class={line.kind}
          >{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}{line.text}
</span>{/each}</pre>
  </div>

  {#if learning.status === 'proposed' && learning.rewrite}
    <p class="rewrite faint">
      {learning.rewrite === 'requested'
        ? 'The file changed since this was proposed: the learner is rewriting the edit against it.'
        : 'The file changed since this was proposed and the learner could not rewrite the edit: reject it.'}
    </p>
  {/if}

  {#if learning.status === 'proposed' && learning.canDecide}
    {#if rejecting}
      <div class="reject">
        <input
          class="field"
          bind:value={note}
          placeholder="Why not? The learner avoids it from now on."
        />
        <button class="btn ghost" onclick={() => (rejecting = false)}>Back</button>
        <button class="btn" disabled={busy} onclick={() => decide('reject')}
          ><X size={14} />Reject</button
        >
      </div>
    {:else}
      <div class="actions">
        <button class="btn ghost" disabled={busy} onclick={() => (rejecting = true)}>Reject</button>
        <button
          class="btn primary"
          disabled={busy || learning.rewrite !== null}
          onclick={() => decide('accept')}
        >
          <Check size={14} />{opensPullRequest ? 'Accept and open pull request' : 'Accept'}
        </button>
      </div>
    {/if}
  {:else if learning.status !== 'proposed'}
    <div class="decided faint">
      {learning.status === 'rejected' ? 'Rejected' : 'Accepted'} by {learning.decidedBy ??
        'someone'}
      {ago(learning.decidedAt, clock.now)}{#if learning.decisionNote}: “{learning.decisionNote}”{/if}
      {#if learning.prUrl}
        <a class="pr" href={learning.prUrl} target="_blank" rel="noopener noreferrer">
          <GitPullRequest size={12} />#{learning.prNumber}<ExternalLink size={11} />
        </a>
      {:else if learning.status === 'accepted' && learning.target === 'agent'}
        · to apply in Officina's <span class="mono">{learning.file}</span>
      {/if}
    </div>
  {/if}
</article>

<style>
  .learning {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 20px 0;
    border-bottom: 1px solid var(--rule);
  }

  .learning.rejected {
    opacity: 0.6;
  }

  header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .grow {
    flex: 1;
    min-width: 0;
  }

  h3 {
    margin: 0;
    font-size: 19px;
    font-weight: 700;
    font-stretch: 85%;
    line-height: 1.2;
  }

  .meta {
    margin-top: 2px;
    font-size: 12px;
    font-stretch: 85%;
    letter-spacing: 0.04em;
    color: var(--text-2);
  }

  .meta a {
    color: var(--text);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .lesson {
    margin: 0;
    font-size: 14.5px;
    line-height: 1.55;
  }

  .evidence summary {
    cursor: pointer;
    font-weight: 700;
    color: var(--text-2);
  }

  .evidence p {
    margin: 6px 0 0;
    font-size: 13px;
    color: var(--text-2);
    line-height: 1.55;
  }

  .change {
    border-top: 1px solid var(--rule);
  }

  .file {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 0;
    font-size: 12px;
  }

  .file .caps {
    font-size: 11px;
  }

  .diff {
    margin: 0;
    padding: 8px 0;
    max-height: 260px;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.6;
    background: var(--code-bg);
  }

  .diff span {
    display: block;
    padding: 0 10px;
    border-left: 3px solid transparent;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Ink for what lands, grey for what goes: a diff that still reads in greyscale. */
  .diff .added {
    color: var(--text);
    font-weight: 600;
    border-left-color: var(--rule);
    background: var(--tint);
  }

  .diff .context {
    color: var(--text-3);
  }

  .diff .removed {
    color: var(--text-3);
    text-decoration: line-through;
    border-left-color: var(--border);
  }

  /* Tecnica: each learning is a ruled sheet with its title set in Plex Sans. */
  :global([data-look='tecnica']) .learning {
    margin-top: 12px;
    padding: 16px 18px;
    border: 1.5px solid var(--rule);
    background: var(--panel);
  }

  :global([data-look='tecnica']) h3 {
    font-size: 16px;
    font-weight: 600;
    font-stretch: normal;
  }

  :global([data-look='tecnica']) .meta {
    font-family: var(--font-num);
    font-stretch: normal;
    letter-spacing: 0;
  }

  .actions,
  .reject {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .reject .field {
    flex: 1;
    height: 34px;
    padding: 0 10px;
  }

  .rewrite {
    margin: 0;
    font-size: 12.5px;
  }

  .decided {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    font-size: 12.5px;
  }

  .pr {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: 4px;
    color: var(--text);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
</style>

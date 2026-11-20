<script lang="ts">
  import { ExternalLink, GitPullRequest } from '@lucide/svelte';
  import { fade } from 'svelte/transition';
  import { ago } from '#lib/format.ts';
  import { board } from '#lib/state/board.svelte.ts';
  import { clock } from '#lib/state/clock.svelte.ts';
  import type { Learning } from '#lib/types.ts';
  import { learningWork, type SentDecision } from '#lib/working.ts';
  import AgentAvatar from './AgentAvatar.svelte';
  import LearningDecide from './LearningDecide.svelte';
  import LearningEdit from './LearningEdit.svelte';
  import Loader from './Loader.svelte';
  import WorkingTrace from './WorkingTrace.svelte';

  interface Props {
    learning: Learning;
    compact?: boolean;
  }

  let { learning, compact = false }: Props = $props();

  // Only edits to Officina's own prompts stay on the board; the others land as a pull request.
  const opensPullRequest = $derived(learning.target !== 'agent');

  /** The decision this board sent, shown as work until the API reports its claim or the outcome. */
  let sent = $state<SentDecision | null>(null);

  // While a decision is at work, here or on anyone's board, the buttons give way to its status line.
  const work = $derived(learning.status === 'proposed' ? learningWork(learning, sent) : null);

  const STATUS = {
    proposed: { label: 'Proposed', tone: 'accent' },
    accepted: { label: 'Accepted', tone: 'info' },
    applied: { label: 'Applied', tone: 'ok' },
    rejected: { label: 'Rejected', tone: '' }
  } as const;
</script>

<article class="learning {learning.status}" class:working={work}>
  {#if work}<WorkingTrace />{/if}
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
    {#if work}
      <span class="pill at-work" in:fade={{ duration: 300 }}><Loader />Working</span>
    {:else}
      <span class="pill {STATUS[learning.status].tone}">{STATUS[learning.status].label}</span>
    {/if}
  </header>

  <p class="lesson">{learning.lesson}</p>

  <details class="evidence">
    <summary class="caps">Evidence</summary>
    <p>{learning.evidence}</p>
  </details>

  <LearningEdit {learning} {opensPullRequest} />

  {#if learning.status === 'proposed' && learning.rewrite}
    <p class="rewrite faint">
      {learning.rewrite === 'requested'
        ? 'The file changed since this was proposed: the learner is rewriting the edit against it.'
        : 'The file changed since this was proposed and the learner could not rewrite the edit: reject it.'}
    </p>
  {/if}

  {#if work || (learning.status === 'proposed' && learning.canDecide)}
    <LearningDecide {learning} {work} {opensPullRequest} bind:sent />
  {:else if learning.status !== 'proposed'}
    <div class="decided faint" in:fade={{ duration: 350 }}>
      {learning.status === 'rejected' ? 'Rejected' : 'Accepted'} by {learning.decidedBy ??
        'someone'}
      {ago(learning.decidedAt, clock.now)}{#if learning.decisionNote}: “{learning.decisionNote}”{/if}
      {#if learning.prUrl}
        <a class="pr" href={learning.prUrl} target="_blank" rel="noopener noreferrer">
          <GitPullRequest size={12} />#{learning.prNumber}<ExternalLink size={11} />
        </a>
        {#if learning.prState}{learning.prState}{/if}
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

  /* At work: the sheet's frame dims, a stretch of ink runs round it and its text steps back.
     Modernista draws no frame, so a working sheet gets one, outside its text so nothing moves. */
  .learning.working {
    --frame: 1px;
    position: relative;
    margin: 0 -16px;
    padding: 20px 16px;
    border: 1px solid color-mix(in srgb, var(--rule) 22%, var(--border));
    animation: settle 0.35s ease both;
  }

  .learning.working .lesson,
  .learning.working :global(.change) {
    opacity: 0.6;
    transition: opacity 0.25s;
  }

  @keyframes settle {
    from {
      border-color: var(--rule);
    }
  }

  .pill.at-work {
    --loader-size: 10px;
    color: var(--text);
    font-weight: 800;
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

  /* Tecnica: each learning is a ruled sheet with its title set in Plex Sans. */
  :global([data-look='tecnica']) .learning {
    margin-top: 12px;
    padding: 16px 18px;
    border: 1.5px solid var(--rule);
    background: var(--panel);
  }

  :global([data-look='tecnica']) .learning.working {
    --frame: 1.5px;
    margin: 12px 0 0;
    padding: 16px 18px;
    border: 1.5px solid color-mix(in srgb, var(--rule) 30%, var(--border));
  }

  :global([data-look='tecnica']) .pill.at-work {
    font-weight: 500;
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

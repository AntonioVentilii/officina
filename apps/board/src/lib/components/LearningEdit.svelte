<!-- A learning's edit as it would land: the file, where it goes, and the diff people approve. -->
<script lang="ts">
  import { Bot, FileText } from '@lucide/svelte';
  import { editLines } from '#lib/diff.ts';
  import type { Learning } from '#lib/types.ts';

  interface Props {
    learning: Learning;
    /** Whether accepting it opens a pull request, rather than staying with Officina's prompts. */
    opensPullRequest: boolean;
  }

  let { learning, opensPullRequest }: Props = $props();

  const TARGET_LABELS = {
    docs: 'agent docs',
    project: 'project docs',
    agent: 'Officina agent prompt'
  } as const;

  // The diff people approve is exactly what lands; lines the edit keeps show as context.
  const lines = $derived(editLines(learning.find, learning.text));
</script>

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

<style>
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
</style>

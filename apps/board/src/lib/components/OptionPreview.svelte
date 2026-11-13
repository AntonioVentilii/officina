<script lang="ts">
  import DOMPurify from 'dompurify';
  import { ExternalLink } from '@lucide/svelte';
  import type { OptionPreview } from '$lib/types';
  import Markdown from './Markdown.svelte';

  interface Props {
    preview: OptionPreview;
    /** Names the mock's frame for screen readers. */
    label: string;
  }

  let { preview, label }: Props = $props();

  /*
   * An HTML mock is agent-written: sanitized, then drawn in a sandboxed frame with no scripts, no
   * same origin and a policy of its own that loads nothing from anywhere, only inline styles and
   * embedded images. Its styles cannot reach the board, and the board's cannot reach it.
   */
  const FRAME_POLICY =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

  const mock = (body: string) =>
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}"><style>body{margin:12px;font:14px/1.5 system-ui,sans-serif;color:#111;background:#fff}</style>${DOMPurify.sanitize(
      body,
      {
        FORBID_TAGS: [
          'form',
          'input',
          'button',
          'iframe',
          'object',
          'embed',
          'link',
          'meta',
          'base'
        ],
        ALLOWED_URI_REGEXP: /^(?:#|data:image\/(?:png|gif|jpe?g|webp);)/i
      }
    )}`;

  const host = (url: string) => new URL(url).host;
</script>

<div class="preview">
  {#if preview.kind === 'text'}
    <div class="words">
      <div class="caps faint">Now</div>
      <div class="before">{preview.before || '(nothing)'}</div>
      <div class="caps faint">After</div>
      <div class="after">{preview.after || '(nothing)'}</div>
    </div>
  {:else if preview.kind === 'markdown'}
    <div class="sample"><Markdown source={preview.body} /></div>
  {:else if preview.kind === 'html'}
    <iframe
      class="sample mock"
      title={label}
      sandbox=""
      referrerpolicy="no-referrer"
      srcdoc={mock(preview.body)}
    ></iframe>
  {:else if preview.kind === 'link'}
    <a class="open" href={preview.url} target="_blank" rel="noopener noreferrer">
      <ExternalLink size={14} />{preview.label ?? 'Open the preview'}<span class="faint"
        >{host(preview.url)}</span
      >
    </a>
  {/if}
</div>

<style>
  /* A preview shows the product as people would see it, so it keeps the page's own colours. */
  .preview,
  .preview .sample :global(.md) {
    color: var(--text);
  }

  .words {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 10px;
    align-items: baseline;
    padding: 10px 12px;
    background: var(--panel);
    border: 1px solid var(--border);
    font-size: 13.5px;
  }

  .words .caps {
    font-size: 10.5px;
  }

  .before {
    color: var(--text-3);
    text-decoration: line-through;
  }

  .after {
    font-weight: 600;
  }

  .sample {
    display: block;
    width: 100%;
    max-height: 320px;
    overflow: auto;
    padding: 10px 12px;
    background: var(--panel);
    border: 1px solid var(--border);
  }

  .mock {
    height: 220px;
    max-height: none;
    padding: 0;
    background: #fff;
    resize: vertical;
  }

  .open {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .open .faint {
    text-decoration: none;
    font-size: 12px;
  }
</style>

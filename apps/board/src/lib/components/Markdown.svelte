<script lang="ts">
  import DOMPurify from 'dompurify';
  import { marked } from 'marked';

  interface Props {
    source: string;
  }

  let { source }: Props = $props();

  // Agent-written text is data: rendered, then sanitized, and links open outside the board.
  const html = $derived(
    DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks: false }), {
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'],
      FORBID_ATTR: ['style']
    })
  );

  const external = (node: HTMLElement) => {
    const apply = () => {
      for (const link of node.querySelectorAll('a[href]')) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(node, { childList: true, subtree: true });
    return { destroy: () => observer.disconnect() };
  };
</script>

<div class="md" use:external>{@html html}</div>

<style>
  .md {
    font-size: 14px;
    line-height: 1.65;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    line-height: 1.3;
    margin: 1.6em 0 0.5em;
    letter-spacing: -0.01em;
  }

  .md :global(h1) {
    font-size: 20px;
    margin-top: 0.2em;
  }

  .md :global(h2) {
    font-size: 16px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }

  .md :global(h3) {
    font-size: 14px;
  }

  .md :global(p),
  .md :global(ul),
  .md :global(ol) {
    margin: 0.6em 0;
  }

  .md :global(ul),
  .md :global(ol) {
    padding-left: 1.4em;
  }

  .md :global(li + li) {
    margin-top: 0.25em;
  }

  .md :global(a) {
    color: var(--info);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .md :global(code) {
    font-family: var(--font-mono);
    font-size: 12.5px;
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--panel-3);
  }

  .md :global(pre) {
    padding: 12px 14px;
    border-radius: var(--radius-sm);
    background: var(--code-bg);
    border: 1px solid var(--border);
    overflow-x: auto;
  }

  .md :global(pre code) {
    padding: 0;
    background: none;
  }

  .md :global(blockquote) {
    margin: 0.8em 0;
    padding: 2px 14px;
    border-left: 3px solid var(--border-strong);
    color: var(--text-2);
  }

  .md :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 0.8em 0;
    font-size: 13px;
    display: block;
    overflow-x: auto;
  }

  .md :global(th),
  .md :global(td) {
    padding: 6px 10px;
    border: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
  }

  .md :global(th) {
    background: var(--panel-2);
    font-weight: 600;
  }

  .md :global(hr) {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 1.5em 0;
  }
</style>

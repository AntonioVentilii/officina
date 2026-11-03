<script lang="ts">
  import { X } from '@lucide/svelte';
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
  }

  let { title, onclose, children, footer }: Props = $props();

  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    dialog?.showModal();
  });
</script>

<dialog
  bind:this={dialog}
  {onclose}
  onclick={(event) => event.target === dialog && dialog?.close()}
  aria-label={title}
>
  <div class="box">
    <header>
      <h2>{title}</h2>
      <button class="btn ghost icon" onclick={() => dialog?.close()} aria-label="Close"
        ><X size={16} /></button
      >
    </header>
    <div class="body">{@render children()}</div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
  </div>
</dialog>

<style>
  dialog {
    padding: 0;
    border: 0;
    background: none;
    max-width: min(560px, calc(100vw - 32px));
    width: 100%;
    color: var(--text);
  }

  dialog::backdrop {
    background: var(--backdrop);
  }

  dialog[open] {
    animation: rise 0.22s var(--ease);
  }

  .box {
    background: var(--panel);
    border-top: 6px solid var(--rule);
  }

  header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    padding: 22px 16px 14px 24px;
    border-bottom: 1px solid var(--rule);
  }

  h2 {
    margin: 0;
    font-size: 32px;
    font-weight: 800;
    font-stretch: 70%;
    line-height: 0.9;
  }

  .body {
    padding: 20px 24px 22px;
  }

  :global([data-look='tecnica']) .box {
    border: 1.5px solid var(--rule);
  }

  :global([data-look='tecnica']) header {
    padding: 16px 12px 12px 20px;
    border-bottom-width: 1.5px;
  }

  :global([data-look='tecnica']) h2 {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    font-stretch: normal;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 24px;
    border-top: 1px solid var(--border);
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.98);
    }
  }
</style>

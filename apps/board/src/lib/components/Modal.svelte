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
    backdrop-filter: blur(3px);
  }

  dialog[open] {
    animation: rise 0.22s var(--ease);
  }

  .box {
    border-radius: var(--radius-lg);
    background: var(--panel);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow-lg);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 14px 0 20px;
  }

  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 650;
  }

  .body {
    padding: 14px 20px 18px;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.98);
    }
  }
</style>

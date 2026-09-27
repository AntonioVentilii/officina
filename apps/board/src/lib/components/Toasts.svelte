<script lang="ts">
  import { CircleAlert, CircleCheck } from '@lucide/svelte';
  import { toasts } from '$lib/state/toasts.svelte';
</script>

<div class="toasts" aria-live="polite">
  {#each toasts.items as toast (toast.id)}
    <button class="toast {toast.kind}" onclick={() => toasts.dismiss(toast.id)}>
      {#if toast.kind === 'ok'}<CircleCheck size={16} />{:else}<CircleAlert size={16} />{/if}
      <span>{toast.text}</span>
    </button>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: min(380px, calc(100vw - 40px));
  }

  .toast {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 11px 14px;
    border-radius: var(--radius);
    border: 1px solid var(--border-strong);
    background: var(--panel);
    box-shadow: var(--shadow-lg);
    text-align: left;
    font-size: 13px;
    animation: slide 0.25s var(--ease);
  }

  .ok :global(svg) {
    color: var(--ok);
    flex: none;
  }

  .error :global(svg) {
    color: var(--danger);
    flex: none;
  }

  @keyframes slide {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
  }
</style>

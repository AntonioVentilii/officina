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

  /* Toasts are solid slabs of the strong rule colour; a failure is the one red slab. */
  .toast {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 16px;
    border: 0;
    background: var(--rule);
    color: var(--on-ink);
    text-align: left;
    font-size: 14px;
    animation: slide 0.25s var(--ease);
  }

  .toast :global(svg) {
    flex: none;
    margin-top: 2px;
  }

  .error {
    background: var(--danger);
    color: #ffffff;
  }

  @keyframes slide {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
  }
</style>

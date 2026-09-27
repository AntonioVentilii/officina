<script lang="ts">
  import { goto } from '$app/navigation';
  import { post } from '$lib/api';
  import { board } from '$lib/state/board.svelte';
  import { session } from '$lib/state/session.svelte';
  import { toasts } from '$lib/state/toasts.svelte';
  import Modal from './Modal.svelte';

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  let title = $state('');
  let request = $state('');
  let busy = $state(false);

  const ready = $derived(title.trim().length >= 3 && request.trim().length > 0);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!ready || !session.projectId) return;
    busy = true;
    try {
      const created = await post<{ number: number }>(`/api/projects/${session.projectId}/tasks`, {
        title: title.trim(),
        request: request.trim()
      });
      toasts.show('ok', `Request #${created.number} opened`);
      await board.refresh();
      onclose();
      await goto(`/tasks/${created.number}`);
    } catch (error) {
      toasts.show('error', (error as Error).message);
    } finally {
      busy = false;
    }
  };
</script>

<Modal title="New request" {onclose}>
  <form id="new-request" onsubmit={submit}>
    <label>
      <span>What should change?</span>
      <input
        class="field"
        bind:value={title}
        maxlength="200"
        placeholder="Replace betting words in battle copy"
        required
      />
    </label>
    <label>
      <span>Describe the outcome</span>
      <textarea
        class="field"
        bind:value={request}
        rows="7"
        placeholder="What people should see or be able to do afterwards, where, and anything that must not change. Plain words are fine: an agent turns this into a spec for review."
        required></textarea>
    </label>
    <p class="hint faint">
      A maintainer triages it, then the spec agent writes a spec you can review.
    </p>
  </form>
  {#snippet footer()}
    <button class="btn ghost" type="button" onclick={onclose}>Cancel</button>
    <button class="btn primary" type="submit" form="new-request" disabled={!ready || busy}>
      {busy ? 'Opening…' : 'Open request'}
    </button>
  {/snippet}
</Modal>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  label span {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-2);
  }

  .hint {
    margin: 0;
    font-size: 12px;
  }
</style>

<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { post } from '$lib/api';
  import { board } from '$lib/state/board.svelte';
  import { session } from '$lib/state/session.svelte';
  import { toasts } from '$lib/state/toasts.svelte';
  import Modal from './Modal.svelte';

  interface Props {
    onclose: () => void;
    /** A starting point, such as one of the guide's examples, for the person to fill in. */
    draft?: { readonly title: string; readonly request: string };
  }

  let { onclose, draft }: Props = $props();

  // Copied once: the person edits it from here, and a later draft opens a new form.
  let title = $state(untrack(() => draft?.title ?? ''));
  let request = $state(untrack(() => draft?.request ?? ''));
  let busy = $state(false);
  let interview = $state(true);

  const limits = $derived(session.me?.limits);
  const ready = $derived(
    limits !== undefined && title.trim().length >= limits.title.min && request.trim().length > 0
  );

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!ready || !session.projectId) return;
    busy = true;
    try {
      const created = await post<{ number: number }>(`/api/projects/${session.projectId}/tasks`, {
        title: title.trim(),
        request: request.trim(),
        interview
      });
      toasts.show('ok', `Request #${created.number} opened`);
      // The request exists now: a failed refresh must not leave the form open to be sent twice.
      onclose();
      void board.refresh();
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
      <span>What do you need?</span>
      <input
        class="field"
        bind:value={title}
        maxlength={limits?.title.max}
        placeholder="Replace betting words in battle copy"
        required
      />
    </label>
    <label>
      <span>Details</span>
      <textarea
        class="field"
        bind:value={request}
        rows="5"
        placeholder="What should people see or be able to do afterwards? Plain words are fine."
        required></textarea>
    </label>
    <label class="check">
      <input type="checkbox" bind:checked={interview} />
      <span>Let an agent ask me a few questions first</span>
    </label>
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
    font-size: 11.5px;
    font-stretch: 85%;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-2);
  }

  :global([data-look='tecnica']) label span {
    font-family: var(--font-display);
    font-size: 12.5px;
    font-stretch: normal;
    font-weight: 600;
  }

  .check {
    flex-direction: row;
    align-items: flex-start;
    gap: 8px;
    cursor: pointer;
  }

  .check input {
    margin-top: 3px;
    accent-color: var(--text);
  }

  .check > span {
    font-size: 14px;
    font-weight: 400;
    font-stretch: 100%;
    letter-spacing: 0;
    text-transform: none;
    color: var(--text);
  }
</style>

<script lang="ts">
  import { post } from '$lib/api';
  import { session } from '$lib/state/session.svelte';
  import { toasts } from '$lib/state/toasts.svelte';

  interface Props {
    number: number;
    onchanged: () => void;
  }

  let { number, onchanged }: Props = $props();

  let open = $state(false);
  let title = $state('');
  let checked = $state('');
  let busy = $state(false);

  const limits = $derived(session.me?.limits.prTitle);
  const ready = $derived(limits !== undefined && title.trim().length >= limits.min);

  const lines = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

  const handIn = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!session.projectId || !ready) return;
    busy = true;
    try {
      await post(`/api/projects/${session.projectId}/tasks/${number}/hand-in`, {
        prTitle: title.trim(),
        verified: lines(checked)
      });
      toasts.show('ok', 'Handed in; the reviewers read it next');
      open = false;
      onchanged();
    } catch (error) {
      toasts.show('error', (error as Error).message);
    } finally {
      busy = false;
    }
  };
</script>

{#if open}
  <form class="hand-in" onsubmit={handIn}>
    <p class="faint">
      Push the task branch <code>officina/task-{number}</code> first, built by hand or with your own agents.
      Officina reads the push from GitHub and opens the pull request.
    </p>
    <label class="caps" for="hand-in-title-{number}">Pull request title</label>
    <input
      id="hand-in-title-{number}"
      class="field"
      bind:value={title}
      placeholder="feat(scope): what it does"
      maxlength={limits?.max}
    />
    <label class="caps" for="hand-in-checked-{number}">What you checked (optional)</label>
    <textarea
      id="hand-in-checked-{number}"
      class="field"
      bind:value={checked}
      rows="3"
      placeholder="One item per line"></textarea>
    <div class="buttons">
      <button type="button" class="btn ghost" onclick={() => (open = false)}>Back</button>
      <button class="btn primary" disabled={busy || !ready}>Hand in</button>
    </div>
  </form>
{:else}
  <button class="btn primary" onclick={() => (open = true)}>Hand in the build</button>
{/if}

<style>
  .hand-in {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  p {
    margin: 0;
    font-size: 13px;
  }
</style>

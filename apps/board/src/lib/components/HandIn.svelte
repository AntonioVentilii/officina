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

  const lines = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

  const handIn = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!session.projectId || title.trim().length < 3) return;
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
    <input class="field" bind:value={title} placeholder="Pull request title" maxlength="120" />
    <textarea
      class="field"
      bind:value={checked}
      rows="3"
      placeholder="What you checked, one per line (optional)"></textarea>
    <div class="buttons">
      <button type="button" class="btn ghost" onclick={() => (open = false)}>Back</button>
      <button class="btn primary" disabled={busy || title.trim().length < 3}>Hand in</button>
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

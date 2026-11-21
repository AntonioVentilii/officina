<script lang="ts">
  import { post } from '#lib/api.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { toasts } from '#lib/state/toasts.svelte.ts';
  import type { TaskDetail } from '#lib/types.ts';

  interface Props {
    task: TaskDetail;
    /** Reloads the task once the question is handed on. */
    onchanged: () => Promise<boolean>;
    busy: boolean;
  }

  let { task, onchanged, busy }: Props = $props();

  /** The select's value before anyone is picked. */
  const NOBODY = '';

  let sending = $state(false);
  let picked = $state(NOBODY);

  const hand = async (event: SubmitEvent) => {
    event.preventDefault();
    const to = task.blocked?.handTo.find((member) => member.id === picked);
    if (!session.projectId || sending || !to) return;
    sending = true;
    try {
      await post(`/api/projects/${session.projectId}/tasks/${task.number}/actions`, {
        type: 'hand_question',
        memberId: to.id
      });
      toasts.show('ok', `Handed to ${to.name}; it waits on them now`);
      picked = NOBODY;
    } catch (error) {
      toasts.show('error', (error as Error).message);
    } finally {
      await onchanged();
      sending = false;
    }
  };
</script>

{#if task.blocked?.handTo.length}
  <form class="hand" onsubmit={hand}>
    <label for="task-{task.number}-hand">Hand it to</label>
    <select
      id="task-{task.number}-hand"
      class="field"
      bind:value={picked}
      disabled={sending || busy}
    >
      <option value={NOBODY}>Choose a member</option>
      {#each task.blocked.handTo as member (member.id)}
        <option value={member.id}>{member.name}</option>
      {/each}
    </select>
    <button class="btn" disabled={sending || busy || picked === NOBODY}>Hand on</button>
  </form>
{/if}

<style>
  .hand {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin-top: 12px;
    font-size: 13px;
  }

  label {
    font-weight: 600;
  }

  select {
    width: auto;
  }
</style>

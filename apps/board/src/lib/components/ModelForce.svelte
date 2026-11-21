<script lang="ts">
  import { post } from '#lib/api.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { toasts } from '#lib/state/toasts.svelte.ts';
  import type { TaskDetail } from '#lib/types.ts';

  interface Props {
    task: TaskDetail;
    /** Reloads the task once the choice is sent. */
    onchanged: () => Promise<boolean>;
  }

  let { task, onchanged }: Props = $props();

  /** The select's value for "no tier forced": the engine's rule picks for each step. */
  const BY_RULE = '';

  const forces = $derived(task.actions.includes('force_model'));
  let sending = $state(false);

  const choose = async (tier: string) => {
    if (!session.projectId || sending) return;
    sending = true;
    try {
      await post(`/api/projects/${session.projectId}/tasks/${task.number}/actions`, {
        type: 'force_model',
        tier: tier === BY_RULE ? null : tier
      });
      const label = task.modelTiers.find((option) => option.tier === tier)?.label;
      toasts.show(
        'ok',
        label ? `Every agent step now runs on ${label}` : 'The rule picks the model again'
      );
    } catch (error) {
      toasts.show('error', (error as Error).message);
    } finally {
      await onchanged();
      sending = false;
    }
  };
</script>

<div class="model">
  <label for="task-{task.number}-model">Model</label>
  {#if forces}
    <select
      id="task-{task.number}-model"
      class="field"
      value={task.forcedModel?.tier ?? BY_RULE}
      disabled={sending}
      onchange={(event) => void choose(event.currentTarget.value)}
    >
      <option value={BY_RULE}>Chosen by rule for each step</option>
      {#each task.modelTiers as option (option.tier)}
        <option value={option.tier}>{option.label} for every step</option>
      {/each}
    </select>
  {:else}
    <span id="task-{task.number}-model"
      >{task.forcedModel
        ? `${task.forcedModel.label} for every step, forced by a maintainer`
        : 'Chosen by rule for each step'}</span
    >
  {/if}
  <p class="faint">
    The rule picks each step's model from the change: its lane, its size, what it touches and
    earlier attempts. A forced tier holds from the next step; the rule still sets how hard each step
    thinks.
  </p>
</div>

<style>
  .model {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin-bottom: 16px;
    font-size: 13px;
  }

  label {
    font-weight: 600;
  }

  select {
    width: auto;
  }

  p {
    flex-basis: 100%;
    margin: 0;
    font-size: 12px;
  }
</style>

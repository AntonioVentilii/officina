<script lang="ts">
  import { post } from '#lib/api.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { toasts } from '#lib/state/toasts.svelte.ts';
  import type { TaskDetail } from '#lib/types.ts';

  interface Props {
    number: number;
    proposal: NonNullable<TaskDetail['proposal']>;
    onchanged: () => void;
  }

  let { number, proposal, onchanged }: Props = $props();

  let busy = $state(false);

  const discard = async () => {
    if (!session.projectId) return;
    busy = true;
    try {
      await post(`/api/projects/${session.projectId}/tasks/${number}/actions`, {
        type: 'discard_proposal'
      });
      toasts.show('ok', 'Proposal discarded');
      onchanged();
    } catch (error) {
      toasts.show('error', (error as Error).message);
    } finally {
      busy = false;
    }
  };
</script>

<p class="proposal">
  <span>
    Claude proposed approving this for you, through the app named "{proposal.via.client}" (its own
    name, not verified), connection {proposal.via.connection} under Connected apps. It counts only once
    you approve it here.
  </span>
  <button class="btn ghost" disabled={busy} onclick={discard}>Discard</button>
</p>

<style>
  .proposal {
    display: flex;
    flex-basis: 100%;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin: 0;
    padding: 8px 12px;
    border-left: 3px solid var(--accent);
    font-size: 13px;
  }
</style>

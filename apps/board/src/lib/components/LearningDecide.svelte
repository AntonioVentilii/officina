<!--
  The decision on a proposed learning: Accept, or Reject with a note. While a decision is at work, on
  this board or anyone's, the buttons give way to its status line in the same place.
-->
<script lang="ts">
  import { Check, X } from '@lucide/svelte';
  import { fly } from 'svelte/transition';
  import { post } from '#lib/api.ts';
  import { board } from '#lib/state/board.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { toasts } from '#lib/state/toasts.svelte.ts';
  import type { Learning, LearningDecision } from '#lib/types.ts';
  import type { SentDecision, Work } from '#lib/working.ts';
  import Working from './Working.svelte';

  interface Props {
    learning: Learning;
    /** The work under way on the learning, if any. */
    work: Work | null;
    opensPullRequest: boolean;
    /** The decision this board sent, shown as work until the API reports its claim or the outcome. */
    sent: SentDecision | null;
  }

  let { learning, work, opensPullRequest, sent = $bindable() }: Props = $props();

  let rejecting = $state(false);
  let note = $state('');
  /**
   * The learning as it stood when a refresh after the answer failed to land. That proves nothing
   * about the claim, so the decision stays shown until a later refresh replaces the learning.
   */
  let heldOver = $state.raw<Learning | null>(null);

  $effect(() => {
    if (!heldOver || learning === heldOver) return;
    heldOver = null;
    sent = null;
  });

  const decide = async (decision: LearningDecision) => {
    if (!session.projectId || work) return;
    sent = { decision, since: new Date().toISOString() };
    try {
      const { rewriting } = await post<{ rewriting: boolean }>(
        `/api/projects/${session.projectId}/learnings/${learning.id}`,
        {
          decision,
          // The edit shown here: one rewritten since is never accepted unseen.
          rewrittenAt: learning.rewrittenAt,
          ...(note.trim() ? { note: note.trim() } : {})
        }
      );
      toasts.show(
        'ok',
        decision === 'reject'
          ? 'Learning rejected'
          : rewriting
            ? 'The file changed since: the learner is rewriting the edit, check it again when it is back'
            : opensPullRequest
              ? 'Accepted: pull request opened'
              : 'Accepted for the Officina prompts'
      );
      rejecting = false;
    } catch (error) {
      toasts.show('error', (error as Error).message);
    } finally {
      // Only a refresh that lands says whether the decision is still at work (an answer lost on the
      // way while the server goes on), so the buttons never come back before the API has spoken.
      if (await board.refresh()) sent = null;
      else heldOver = learning;
    }
  };
</script>

<div class="swap">
  {#if work}
    <Working {work} />
  {:else if rejecting}
    <div class="reject" out:fly={{ y: 6, duration: 220 }}>
      <input
        class="field"
        bind:value={note}
        placeholder="Why not? The learner avoids it from now on."
      />
      <button class="btn ghost" onclick={() => (rejecting = false)}>Back</button>
      <button class="btn" onclick={() => decide('reject')}><X size={14} />Reject</button>
    </div>
  {:else}
    <div class="actions" out:fly={{ y: 6, duration: 220 }}>
      <button class="btn ghost" onclick={() => (rejecting = true)}>Reject</button>
      <!-- A repeat of an edit already accepted with its pull request can only be rejected. -->
      {#if !learning.duplicateOf}
        <button
          class="btn primary"
          disabled={learning.rewrite !== null}
          onclick={() => decide('accept')}
        >
          <Check size={14} />{opensPullRequest ? 'Accept and open pull request' : 'Accept'}
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* The buttons and the status line share one cell, so one gives way to the other in place. */
  .swap {
    display: grid;
  }

  .swap > :global(*) {
    grid-area: 1 / 1;
  }

  .actions,
  .reject {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .reject .field {
    flex: 1;
    height: 34px;
    padding: 0 10px;
  }
</style>

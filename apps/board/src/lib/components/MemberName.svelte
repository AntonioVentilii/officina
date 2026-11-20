<script lang="ts">
  import { Check, Pencil, X } from '@lucide/svelte';
  import { post } from '#lib/api.ts';
  import { board } from '#lib/state/board.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { toasts } from '#lib/state/toasts.svelte.ts';
  import type { MemberActivity } from '#lib/types.ts';

  interface Props {
    member: MemberActivity;
    /** Called once a new name is saved, for the page to reload what records it. */
    onrenamed: () => void;
  }

  let { member, onrenamed }: Props = $props();

  /** The name as typed so far, while it is being edited. */
  let draft = $state<string | null>(null);
  let saving = $state(false);

  const save = async () => {
    if (!session.projectId || draft === null) return;
    saving = true;
    try {
      await post(`/api/projects/${session.projectId}/members/${member.id}/name`, { name: draft });
      draft = null;
      onrenamed();
      // Your own name is also in the sidebar, which reads it from the session.
      await Promise.all([
        board.refresh(),
        member.id === session.me?.member.id ? session.load() : undefined
      ]);
    } catch (error) {
      toasts.show('error', (error as Error).message);
    } finally {
      saving = false;
    }
  };

  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Enter') void save();
    if (event.key === 'Escape') draft = null;
  };
</script>

{#if draft !== null}
  <span class="rename">
    <input
      class="field"
      bind:value={draft}
      maxlength={session.me?.limits.memberName}
      aria-label="Name and surname"
      onkeydown={keys}
      {@attach (input) => input.focus()}
    />
    <button
      class="btn sm icon"
      title="Save name"
      aria-label="Save name"
      disabled={saving || !draft.trim()}
      onclick={save}><Check size={14} /></button
    >
    <button class="btn sm icon" title="Cancel" aria-label="Cancel" onclick={() => (draft = null)}
      ><X size={14} /></button
    >
  </span>
{:else}
  <span class="name"
    >{member.name}{#if member.renamable}
      <button
        class="edit"
        title="Change name"
        aria-label="Change {member.name}'s name"
        onclick={() => (draft = member.name)}><Pencil size={12} /></button
      >
    {/if}</span
  >
{/if}

<style>
  .name {
    font-size: 15px;
    font-weight: 600;
  }

  .rename {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .rename .field {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 14px;
  }

  .edit {
    margin-left: 6px;
    padding: 2px;
    border: 0;
    background: none;
    color: var(--text-2);
    cursor: pointer;
    vertical-align: middle;
  }

  .edit:hover {
    color: var(--text);
  }
</style>

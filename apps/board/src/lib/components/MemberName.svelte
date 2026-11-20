<script lang="ts">
  import { Check, Pencil, X } from '@lucide/svelte';
  import { post } from '#lib/api.ts';
  import { board } from '#lib/state/board.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { toasts } from '#lib/state/toasts.svelte.ts';

  interface Props {
    id: string;
    name: string;
    /** Whether the viewer may change it: their own, or one they manage in every project. */
    renamable: boolean;
    size?: number;
    /** Whether the name is being edited, for a parent that makes room for the field meanwhile. */
    editing?: boolean;
  }

  let { id, name, renamable, size = 15, editing = $bindable(false) }: Props = $props();

  /** The name as typed so far, while it is being edited. */
  let draft = $state('');
  let saving = $state(false);

  const save = async () => {
    if (!session.projectId || !editing) return;
    saving = true;
    try {
      await post(`/api/projects/${session.projectId}/members/${id}/name`, { name: draft });
      editing = false;
      // Your own name is also in the sidebar, which reads it from the session.
      await Promise.all([
        board.refresh(),
        id === session.me?.member.id ? session.load() : undefined
      ]);
    } catch (error) {
      toasts.show('error', (error as Error).message);
    } finally {
      saving = false;
    }
  };

  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Enter') void save();
    if (event.key === 'Escape') editing = false;
  };
</script>

{#if editing}
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
    <button class="btn sm icon" title="Cancel" aria-label="Cancel" onclick={() => (editing = false)}
      ><X size={14} /></button
    >
  </span>
{:else}
  <span class="name" style:font-size="{size}px">
    <span class="text" title={name}>{name}</span>
    {#if renamable && session.projectId}
      <button
        class="edit"
        title="Change name"
        aria-label="Change {name}'s name"
        onclick={() => {
          draft = name;
          editing = true;
        }}><Pencil size={12} /></button
      >
    {/if}
  </span>
{/if}

<style>
  .name {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-weight: 600;
  }

  .text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rename {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .rename .field {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 14px;
  }

  /* Takes the colour of the text around it, so it sits as well in the sidebar as on a page. */
  .edit {
    flex: none;
    display: inline-flex;
    padding: 2px;
    border: 0;
    background: none;
    color: inherit;
    opacity: 0.6;
    cursor: pointer;
  }

  .edit:hover {
    opacity: 1;
  }
</style>

<script lang="ts">
  import type { Via } from '$lib/types';

  interface Props {
    via: Via | null;
  }

  let { via }: Props = $props();
</script>

{#if via}
  <span
    class="via"
    title={`Done through the Claude connector, by an app this member allowed to act for them: connection ${via.connection} under Connected apps. "${via.client}" is the name the app gave itself; Officina does not verify it.`}
    >{via.label} (app named "{via.client}", connection {via.connection})</span
  >
{/if}

<style>
  .via {
    font-size: 12px;
    color: var(--text-2);
  }
</style>

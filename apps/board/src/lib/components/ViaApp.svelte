<script lang="ts">
  interface Props {
    /** The name the app gave itself when it connected; Officina cannot check it. */
    name: string | null;
  }

  let { name }: Props = $props();
</script>

{#if name}
  <span
    class="via"
    title={`Done through the Claude connector, by an app this member allowed to act for them. "${name}" is the name the app gave itself; Officina does not verify it.`}
    >via Claude (app named "{name}")</span
  >
{/if}

<style>
  .via {
    font-size: 12px;
    color: var(--text-2);
  }
</style>

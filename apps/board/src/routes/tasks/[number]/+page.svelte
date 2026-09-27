<script lang="ts">
  import { page } from '$app/state';
  import BoardView from '$lib/components/BoardView.svelte';
  import TaskDrawer from '$lib/components/TaskDrawer.svelte';

  const number = $derived(Number(page.params.number));
</script>

<BoardView />
{#key number}
  <TaskDrawer {number} />
{/key}

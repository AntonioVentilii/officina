<script lang="ts">
  import { page } from '$app/state';
  import BoardView from '$lib/components/BoardView.svelte';
  import TaskDrawer from '$lib/components/TaskDrawer.svelte';
  import { session } from '$lib/state/session.svelte';

  const number = $derived(Number(page.params.number));

  // Task numbers are per project: a link from outside the board (the Claude connector) names the
  // project, and the drawer waits until that project is the selected one.
  const wanted = $derived.by(() => {
    const id = page.url.searchParams.get('project');
    return id && session.me?.projects.some((project) => project.id === id) ? id : null;
  });

  $effect(() => {
    if (wanted && wanted !== session.projectId) session.selectProject(wanted);
  });
</script>

<BoardView />
{#key `${session.projectId}:${number}`}
  {#if !wanted || wanted === session.projectId}
    <TaskDrawer {number} />
  {/if}
{/key}

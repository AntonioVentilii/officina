<script lang="ts">
  import { goto } from '$app/navigation';
  import { session } from '$lib/state/session.svelte';
  import AgentAvatar from '$lib/components/AgentAvatar.svelte';
  import RunRow from '$lib/components/RunRow.svelte';
  import { money } from '$lib/format';
  import { board } from '$lib/state/board.svelte';

  let open = $state<Record<string, boolean>>({});

  const stats = $derived(
    board.agents.map((entry) => {
      const runs = board.runs.filter((run) => run.role === entry.role);
      const finished = runs.filter((run) => run.status === 'succeeded' || run.status === 'failed');
      return {
        ...entry,
        running: runs.some((run) => run.status === 'running'),
        runs: runs.length,
        success: finished.length
          ? Math.round(
              (finished.filter((run) => run.status === 'succeeded').length / finished.length) * 100
            )
          : null,
        cost: runs.reduce((sum, run) => sum + (run.costCents ?? 0), 0)
      };
    })
  );

  const total = $derived(board.runs.reduce((sum, run) => sum + (run.costCents ?? 0), 0));

  // Maintainers' page: the API refuses its data to anyone else.
  $effect(() => {
    if (session.project && !session.technical) void goto('/', { replaceState: true });
  });
</script>

<div class="page">
  <header>
    <h1 class="page-title">Agents</h1>
    <p class="muted">
      {board.running.length
        ? `${board.running.length} working right now.`
        : 'Nobody is working right now.'}
      Recent sessions cost {money(total) || '$0.00'} in total.
    </p>
  </header>

  <div class="roster">
    {#each stats as agent (agent.role)}
      <div class="agent" class:running={agent.running}>
        <AgentAvatar role={agent.role} label={agent.label} running={agent.running} size={40} />
        <div class="info">
          <strong>{agent.label}</strong>
          <span class="does">{agent.does}</span>
          <span class="numbers caps num">
            {[
              `${agent.runs} runs`,
              agent.success !== null ? `${agent.success}% ok` : '',
              agent.cost ? money(agent.cost) : ''
            ]
              .filter(Boolean)
              .join('   ')}
          </span>
        </div>
      </div>
    {/each}
  </div>

  <h2>Sessions<span class="count num">{board.runs.length}</span></h2>
  {#if board.runs.length}
    <div class="runs">
      {#each board.runs as run (run.id)}
        <RunRow
          {run}
          showTask
          bind:open={() => open[run.id] ?? false, (value) => (open[run.id] = value)}
        />
      {/each}
    </div>
  {:else if board.loaded}
    <p class="empty">No sessions yet.</p>
  {/if}
</div>

<style>
  .page {
    height: 100%;
    overflow-y: auto;
    padding-bottom: 48px;
  }

  header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px 28px;
    padding: 28px 32px 22px;
    border-bottom: 3px solid var(--rule);
  }

  header p {
    margin: 0;
    max-width: 460px;
  }

  .roster {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    border-bottom: 1px solid var(--rule);
  }

  .agent {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 22px 20px 20px;
    border-right: 1px solid var(--rule);
  }

  .info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    font-size: 13px;
    line-height: 1.4;
  }

  .info strong {
    font-size: 22px;
    font-weight: 800;
    font-stretch: 75%;
    line-height: 1.1;
  }

  .does {
    color: var(--text-2);
  }

  .numbers {
    margin-top: 6px;
    color: var(--text);
    white-space: pre;
  }

  h2,
  .runs,
  .empty {
    max-width: 1080px;
    margin-left: 32px;
    margin-right: 32px;
  }

  h2 {
    display: flex;
    align-items: flex-end;
    margin-top: 40px;
    margin-bottom: 0;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--rule);
    font-size: 22px;
    font-weight: 800;
    font-stretch: 75%;
  }

  .count {
    margin-left: auto;
    font-size: 40px;
    font-weight: 300;
    font-stretch: 62%;
    line-height: 0.75;
  }

  .runs {
    display: flex;
    flex-direction: column;
  }

  .empty {
    padding: 24px 0;
    color: var(--text-3);
  }

  /* Tecnica: a ruled header strip and condensed section heads, numbers in mono. */
  :global([data-look='tecnica']) header {
    align-items: center;
    padding: 18px 24px;
    background: var(--panel);
    border-bottom-width: 1.5px;
  }

  :global([data-look='tecnica']) h2 {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    font-stretch: normal;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  :global([data-look='tecnica']) .count {
    font-size: 12px;
    font-weight: 400;
    font-stretch: normal;
    line-height: 1.5;
  }

  :global([data-look='tecnica']) .roster {
    gap: 12px;
    padding: 20px 24px 0;
    border: 0;
  }

  :global([data-look='tecnica']) .agent {
    border: 1.5px solid var(--rule);
    background: var(--panel);
  }

  :global([data-look='tecnica']) .info strong {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    font-stretch: normal;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  @media (max-width: 720px) {
    header {
      padding: 20px 16px 16px;
    }

    header :global(.page-title) {
      font-size: 56px;
    }

    h2,
    .runs,
    .empty {
      margin-left: 16px;
      margin-right: 16px;
    }
  }
</style>

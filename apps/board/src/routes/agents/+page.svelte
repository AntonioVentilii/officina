<script lang="ts">
  import AgentAvatar from '$lib/components/AgentAvatar.svelte';
  import RunRow from '$lib/components/RunRow.svelte';
  import { money } from '$lib/format';
  import { board } from '$lib/state/board.svelte';

  const ROLES = [
    {
      role: 'spec',
      label: 'Spec writer',
      does: 'Reads the repo and writes a spec in its template'
    },
    { role: 'builder', label: 'Builder', does: 'Implements the approved spec on the task branch' },
    {
      role: 'reviewer_spec',
      label: 'Spec reviewer',
      does: 'Checks the diff does what the spec says, no more'
    },
    {
      role: 'reviewer_correctness',
      label: 'Code reviewer',
      does: 'Checks correctness and project conventions'
    },
    { role: 'chooser', label: 'Verification guide', does: 'Writes what people must check, and who' }
  ];

  let open = $state<Record<string, boolean>>({});

  const stats = $derived(
    ROLES.map((entry) => {
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
</script>

<div class="page">
  <header>
    <h1>Agents</h1>
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
        <AgentAvatar role={agent.role} label={agent.label} running={agent.running} size={34} />
        <div class="info">
          <strong>{agent.label}</strong>
          <span class="faint">{agent.does}</span>
          <span class="numbers num">
            {agent.runs} runs{#if agent.success !== null}
              · {agent.success}% ok{/if}{#if agent.cost}
              · {money(agent.cost)}{/if}
          </span>
        </div>
      </div>
    {/each}
  </div>

  <h2>Sessions</h2>
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
    padding: 18px 24px 40px;
    max-width: 1080px;
  }

  h1 {
    margin: 0;
    font-size: 20px;
    letter-spacing: -0.02em;
  }

  header p {
    margin: 4px 0 18px;
  }

  h2 {
    margin: 28px 0 10px;
    font-size: 11.5px;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
  }

  .roster {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 10px;
  }

  .agent {
    display: flex;
    gap: 12px;
    padding: 14px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--panel);
  }

  .agent.running {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }

  .info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    font-size: 12.5px;
    line-height: 1.4;
  }

  .info strong {
    font-size: 13.5px;
  }

  .numbers {
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--text-2);
  }

  .runs {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .empty {
    padding: 28px;
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    text-align: center;
    color: var(--text-3);
  }

  @media (max-width: 720px) {
    .page {
      padding: 14px 16px 24px;
    }
  }
</style>

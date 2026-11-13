<script lang="ts">
  import { Check, GitMerge } from '@lucide/svelte';
  import type { TaskDetail } from '$lib/types';
  import MemberAvatar from './MemberAvatar.svelte';

  interface Props {
    people: TaskDetail['people'];
    guards: TaskDetail['guards'];
  }

  let { people, guards }: Props = $props();
</script>

<dl class="people">
  <dt>Asked by</dt>
  <dd><MemberAvatar name={people.requester} size={18} />{people.requester}</dd>

  {#each people.gates as gate (gate.gate)}
    <dt class:current={gate.current}>{gate.does}</dt>
    <dd class="stack">
      {#each gate.requirements as requirement (requirement.label)}
        <span class="line">
          <span class="muted">{requirement.label}:</span>
          {#if requirement.waived}
            <span class="faint">nobody holds it yet, so it is waived</span>
          {:else if requirement.who.length}
            {#each requirement.who as name (name)}
              <span class="name" class:done={requirement.approvedBy.includes(name)}>
                <MemberAvatar {name} size={18} />{name}
                {#if requirement.approvedBy.includes(name)}<Check size={13} />{/if}
              </span>
            {/each}
          {:else}
            <span class="faint">nobody in the project yet</span>
          {/if}
        </span>
      {/each}
      {#if gate.asked.length}
        <span class="line faint">Asked to check: {gate.asked.join(', ')}</span>
      {/if}
    </dd>
  {/each}

  <dt>Builds it</dt>
  <dd>
    {#if people.build.by === 'person'}
      A developer{people.build.who.length ? `: ${people.build.who.join(', ')}` : ''}.
      <span class="muted">{people.build.reason}</span>
    {:else}
      The build agent
    {/if}
  </dd>

  {#if guards.length}
    <dt>Owner's call</dt>
    <dd>Touches {guards.join(', ')}</dd>
  {/if}

  <dt>Merges it</dt>
  <dd>
    <GitMerge size={14} />
    {#if people.merge.by === 'auto'}
      GitHub, once its checks pass
    {:else}
      A person on GitHub{people.merge.who.length ? `: ${people.merge.who.join(', ')}` : ''}
    {/if}
  </dd>
</dl>

<style>
  .people {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 10px 16px;
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
  }

  dt {
    font-weight: 700;
  }

  dt.current::after {
    content: ' (now)';
    font-weight: 400;
  }

  dd {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
  }

  .stack {
    flex-direction: column;
    align-items: flex-start;
  }

  .line,
  .name {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }

  .done {
    font-weight: 700;
  }

  @media (max-width: 640px) {
    .people {
      grid-template-columns: 1fr;
      gap: 4px;
    }

    dd {
      margin-bottom: 8px;
    }
  }
</style>

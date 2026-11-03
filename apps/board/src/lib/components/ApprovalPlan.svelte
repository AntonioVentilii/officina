<script lang="ts">
  import { Eye, Hand, ShieldPlus, Smartphone, UserCheck } from '@lucide/svelte';
  import type { TaskDetail } from '$lib/types';
  import AgentAvatar from './AgentAvatar.svelte';
  import MemberAvatar from './MemberAvatar.svelte';

  interface Props {
    plan: NonNullable<TaskDetail['plan']>;
  }

  let { plan }: Props = $props();

  const DEPTH_ICONS = { glance: Eye, test: Hand, device: Smartphone } as const;
  const DepthIcon = $derived(DEPTH_ICONS[plan.depth]);
</script>

<div class="plan" class:stale={!plan.current}>
  <div class="head">
    <AgentAvatar role="chooser" label="Approval chooser" size={24} />
    <div class="grow">
      <div class="who">
        {plan.gate === 'spec_review' ? 'For the plan' : 'For the result'}
        {#if !plan.current}<span class="pill warn">earlier version</span>{/if}
      </div>
      <p class="rationale">{plan.rationale}</p>
    </div>
    <span class="depth caps" title="How closely to check">
      <DepthIcon size={13} />{plan.depthLabel}
    </span>
  </div>

  {#if plan.extra.length || plan.verifiers.length}
    <ul>
      {#each plan.extra as item (item.label)}
        <li>
          <span class="icon added"><ShieldPlus size={14} /></span>
          <span
            ><strong>Also needs {item.label}</strong> <span class="muted">{item.reason}</span></span
          >
        </li>
      {/each}
      {#each plan.verifiers as verifier (verifier.name)}
        <li>
          <MemberAvatar name={verifier.name} size={20} />
          <span>
            <strong>{verifier.name} is asked to check</strong>
            <span class="muted">{verifier.reason}</span>
          </span>
          <span class="icon faint" title="A request, not a requirement"
            ><UserCheck size={13} /></span
          >
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .plan {
    padding: 4px 0 0;
  }

  .stale {
    opacity: 0.6;
  }

  .head {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .grow {
    flex: 1;
    min-width: 0;
  }

  .who {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13.5px;
    font-weight: 700;
  }

  .rationale {
    margin: 4px 0 0;
    font-size: 13.5px;
    line-height: 1.5;
  }

  .depth {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    font-weight: 700;
    white-space: nowrap;
  }

  ul {
    display: flex;
    flex-direction: column;
    margin: 14px 0 0;
    padding: 0 0 0 34px;
    list-style: none;
  }

  li {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px 0;
    border-top: 1px solid var(--border);
    font-size: 13px;
    line-height: 1.5;
  }

  .icon {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    flex: none;
  }

  @media (max-width: 640px) {
    .head {
      flex-wrap: wrap;
    }

    ul {
      padding-left: 0;
    }
  }
</style>

<script lang="ts">
  import { CircleCheck, CircleHelp, GitMerge, Radio, UserRound } from '@lucide/svelte';
  import { post } from '$lib/api';
  import { session } from '$lib/state/session.svelte';
  import { toasts } from '$lib/state/toasts.svelte';
  import type { TaskDetail } from '$lib/types';
  import AgentAvatar from './AgentAvatar.svelte';
  import Markdown from './Markdown.svelte';

  interface Props {
    task: TaskDetail;
    onchanged: () => void;
    onwatch: () => void;
  }

  let { task, onchanged, onwatch }: Props = $props();

  type Mode = 'changes' | 'decline' | 'cancel' | null;
  let mode = $state<Mode>(null);
  let text = $state('');
  let busy = $state(false);

  const can = (action: TaskDetail['actions'][number]) => task.actions.includes(action);
  const lastEvent = (type: string) =>
    [...task.events].reverse().find((event) => event.type === type);
  const githubApproved = $derived(
    lastEvent('github_approved')?.payload as { login: string; merge: string } | undefined
  );
  const githubFailed = $derived(
    lastEvent('github_approval_failed')?.payload as { login: string; error: string } | undefined
  );
  const gate = $derived(
    task.stage === 'spec_review' ? 'spec' : task.stage === 'verifying' ? 'result' : null
  );
  const mergesToo = $derived(
    gate === 'result' && Boolean(session.me?.github) && Boolean(task.pullRequest)
  );

  const act = async (body: Record<string, string>, done: string) => {
    if (!session.projectId) return;
    busy = true;
    try {
      const result = await post<{ stage: string; satisfied?: boolean }>(
        `/api/projects/${session.projectId}/tasks/${task.number}/actions`,
        body
      );
      toasts.show(
        'ok',
        result.satisfied === false ? 'Approval recorded; more approvals are still needed' : done
      );
      mode = null;
      text = '';
      onchanged();
    } catch (error) {
      toasts.show('error', (error as Error).message);
    } finally {
      busy = false;
    }
  };

  const submitMode = (event: SubmitEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || !mode) return;
    if (mode === 'changes') void act({ type: 'changes', note: value }, 'Sent back with your notes');
    else
      void act(
        { type: mode, reason: value },
        mode === 'decline' ? 'Request declined' : 'Task cancelled'
      );
  };

  const submitAsIs = () => void act({ type: 'submit' }, 'Sent to triage as it is');

  const answer = (event: SubmitEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (value) void act({ type: 'answer', text: value }, 'Answer sent; the step runs again');
  };

  const PLACEHOLDERS: Record<Exclude<Mode, null>, string> = {
    changes: 'What should change? Be specific: the agent works from exactly this.',
    decline: 'Why is this declined? The requester sees it.',
    cancel: 'Why is this cancelled?'
  };
</script>

{#if task.blocked}
  <section class="next blocked">
    <div class="head">
      <CircleHelp size={18} />
      <div>
        <div class="kicker">Question for {task.blocked.askedOf}</div>
        <div class="question"><Markdown source={task.blocked.question} /></div>
      </div>
    </div>
    {#if can('answer')}
      <form onsubmit={answer}>
        <textarea
          class="field"
          bind:value={text}
          rows="3"
          placeholder="Your answer. The step runs again with it."></textarea>
        <div class="buttons">
          {#if can('submit')}
            <button type="button" class="btn ghost" disabled={busy} onclick={submitAsIs}
              >Submit as is</button
            >
          {/if}
          <button class="btn primary" disabled={busy || !text.trim()}>Answer</button>
        </div>
      </form>
    {/if}
  </section>
{:else if task.waitingOn.kind === 'agent'}
  <section class="next agent">
    <div class="head">
      {#if task.running.length}
        <span class="agents">
          {#each task.running as agent (agent.role)}<AgentAvatar
              role={agent.role}
              label={agent.label}
              running
              size={30}
            />{/each}
        </span>
      {:else}
        <span class="idle"><Radio size={18} /></span>
      {/if}
      <div class="grow">
        <div class="kicker">Agents</div>
        <div class="label">{task.waitingOn.label}</div>
      </div>
      {#if can('submit')}
        <button class="btn ghost" disabled={busy} onclick={submitAsIs}>Submit as is</button>
      {/if}
      {#if task.running.length}
        <button class="btn" onclick={onwatch}>Watch live</button>
      {/if}
    </div>
  </section>
{:else if task.waitingOn.kind === 'github'}
  <section class="next github">
    <div class="head">
      <GitMerge size={18} />
      <div class="grow">
        <div class="kicker">Verified</div>
        {#if githubApproved}
          <div class="label">
            Approved on GitHub as @{githubApproved.login}.
            {githubApproved.merge === 'merged'
              ? 'Merged; the task closes itself.'
              : 'Auto-merge is on: GitHub merges once checks pass and threads are resolved.'}
          </div>
        {:else if githubFailed}
          <div class="label">
            Approving on GitHub as @{githubFailed.login} failed: approve and merge there.
          </div>
          <div class="approval faint">{githubFailed.error}</div>
        {:else if session.me?.github}
          <div class="label">
            Approving on GitHub as @{session.me.github.login} once the spec is marked Implemented…
          </div>
        {:else}
          <div class="label">
            Approve and merge the pull request on GitHub; the task closes itself.
          </div>
          {#if session.me?.githubAvailable}
            <div class="approval faint">
              <a class="inline" href="/auth/github/start?mode=link" data-sveltekit-reload
                >Connect GitHub</a
              >
              and your next verification approves and merges from here.
            </div>
          {/if}
        {/if}
      </div>
      {#if task.pullRequestUrl}
        <a
          class="btn"
          class:primary={!githubApproved}
          href={task.pullRequestUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open pull request
        </a>
      {/if}
    </div>
  </section>
{:else if task.waitingOn.kind === 'people'}
  <section class="next people" class:mine={task.waitingOn.me}>
    <div class="head">
      {#if task.waitingOn.me}<span class="you">Your turn</span>{:else}<UserRound size={18} />{/if}
      <div class="grow">
        <div class="label">{task.waitingOn.label}</div>
        {#if task.approval}
          <div class="approval faint">
            {#if task.approval.approvedBy.length}Approved by {task.approval.approvedBy.join(
                ', '
              )}.{/if}
            {#if task.approval.waived.length}Waived, nobody holds the role yet: {task.approval.waived.join(
                ', '
              )}.{/if}
          </div>
        {/if}
      </div>
    </div>

    {#if mode === 'changes' || mode === 'decline'}
      <form onsubmit={submitMode}>
        <textarea class="field" bind:value={text} rows="4" placeholder={PLACEHOLDERS[mode]}
        ></textarea>
        <div class="buttons">
          <button type="button" class="btn ghost" onclick={() => (mode = null)}>Back</button>
          <button class="btn primary" disabled={busy || !text.trim()}>
            {mode === 'changes' ? 'Send back' : 'Decline'}
          </button>
        </div>
      </form>
    {:else}
      <div class="buttons">
        {#if can('accept')}
          <button class="btn ghost" disabled={busy} onclick={() => (mode = 'decline')}
            >Decline</button
          >
          <button
            class="btn primary"
            disabled={busy}
            onclick={() => act({ type: 'accept' }, 'Accepted; the spec agent starts shortly')}
          >
            Accept
          </button>
        {/if}
        {#if can('approve') && gate}
          <button class="btn" disabled={busy} onclick={() => (mode = 'changes')}
            >Request changes</button
          >
          <button
            class="btn primary"
            disabled={busy}
            onclick={() =>
              act(
                { type: 'approve' },
                gate === 'spec' ? 'Spec approved; it goes to build' : 'Verified'
              )}
          >
            <CircleCheck size={15} />{gate === 'spec'
              ? 'Approve spec'
              : mergesToo
                ? 'Approve and merge'
                : 'Approve result'}
          </button>
        {/if}
      </div>
    {/if}
  </section>
{/if}

{#if can('cancel') && !['done', 'declined', 'cancelled'].includes(task.stage)}
  {#if mode === 'cancel'}
    <form class="cancel" onsubmit={submitMode}>
      <textarea class="field" bind:value={text} rows="2" placeholder={PLACEHOLDERS.cancel}
      ></textarea>
      <div class="buttons">
        <button type="button" class="btn ghost" onclick={() => (mode = null)}>Keep it</button>
        <button class="btn danger" disabled={busy || !text.trim()}>Cancel task</button>
      </div>
    </form>
  {:else}
    <div class="cancel-row">
      <button class="link" onclick={() => (mode = 'cancel')}>Cancel this task</button>
    </div>
  {/if}
{/if}

<style>
  .next {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--panel-2);
  }

  .next.mine {
    border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
    background: linear-gradient(135deg, var(--accent-soft), transparent 65%), var(--panel-2);
  }

  .next.blocked {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
    background: linear-gradient(135deg, var(--danger-soft), transparent 65%), var(--panel-2);
  }

  .blocked .head > :global(svg) {
    color: var(--danger);
  }

  .github .head > :global(svg) {
    color: var(--ok);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .blocked .head {
    align-items: flex-start;
  }

  .grow {
    flex: 1;
    min-width: 0;
  }

  .kicker {
    font-size: 11px;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
  }

  .label {
    font-weight: 560;
  }

  .question :global(.md) {
    font-size: 13.5px;
  }

  .agents {
    display: inline-flex;
    gap: 6px;
  }

  .idle {
    color: var(--text-3);
  }

  .you {
    flex: none;
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 700;
    color: var(--accent-text);
    background: var(--accent);
  }

  .approval {
    font-size: 12px;
    margin-top: 2px;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }

  .cancel {
    margin-top: 10px;
  }

  .cancel-row {
    display: flex;
    justify-content: flex-end;
    margin-top: 6px;
  }

  .inline {
    color: var(--info);
    text-decoration: underline;
  }

  .link {
    border: 0;
    background: none;
    padding: 2px 0;
    font-size: 12px;
    color: var(--text-3);
  }

  .link:hover {
    color: var(--danger);
    text-decoration: underline;
  }
</style>

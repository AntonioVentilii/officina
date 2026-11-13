<script lang="ts">
  import { CircleCheck, CircleHelp, GitMerge, Radio, UserRound } from '@lucide/svelte';
  import { post } from '$lib/api';
  import { look } from '$lib/state/look.svelte';
  import { session } from '$lib/state/session.svelte';
  import { toasts } from '$lib/state/toasts.svelte';
  import type { TaskDetail } from '$lib/types';
  import AgentAvatar from './AgentAvatar.svelte';
  import Markdown from './Markdown.svelte';
  import QuestionOptions from './QuestionOptions.svelte';

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
    lastEvent('github_approved')?.payload as { login: string; merge?: string } | undefined
  );
  const githubFailed = $derived(
    lastEvent('github_approval_failed')?.payload as { login: string; error?: string } | undefined
  );
  // The engine's latest word on merging: waiting for a person, or held for unverified commits.
  const held = $derived(
    [...task.events]
      .reverse()
      .find((event) => event.type === 'awaiting_merge' || event.type === 'merge_held')?.type ===
      'merge_held'
  );
  const gate = $derived(
    task.stage === 'spec_review' ? 'spec' : task.stage === 'verifying' ? 'result' : null
  );
  const approvesOnGitHub = $derived(
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

  // What is written in the answer box goes along as a note on the chosen option.
  const choose = (option: string) =>
    void act({ type: 'answer', option, text: text.trim() }, 'Answer sent; the step runs again');

  const PLACEHOLDERS: Record<Exclude<Mode, null>, string> = {
    changes: 'What should change? The agent works from exactly this.',
    decline: 'Why is this declined? The requester sees it.',
    cancel: 'Why is this cancelled?'
  };
</script>

{#if task.blocked}
  <section class="next blocked" class:mine={task.waitingOn.me}>
    <div class="head">
      {#if task.waitingOn.me && look.current === 'tecnica'}<strong class="you-word">Question</strong
        >{:else}<CircleHelp size={18} />{/if}
      <div>
        <div class="kicker caps">A question for {task.blocked.askedOf}</div>
        <div class="question"><Markdown source={task.blocked.question} /></div>
      </div>
    </div>
    {#if task.blocked.options.length}
      <QuestionOptions
        options={task.blocked.options}
        onchoose={can('answer') ? choose : undefined}
        {busy}
      />
    {/if}
    {#if can('answer')}
      <form onsubmit={answer}>
        <textarea
          class="field"
          bind:value={text}
          rows="3"
          placeholder={task.blocked.options.length
            ? 'Your own answer, or a note to send with the option you choose'
            : 'Your answer'}></textarea>
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
        <div class="kicker caps">Agents</div>
        <div class="label">{task.waitingOn.label}</div>
      </div>
      {#if can('submit')}
        <button class="btn ghost" disabled={busy} onclick={submitAsIs}>Submit as is</button>
      {/if}
      {#if session.technical && task.running.length}
        <button class="btn" onclick={onwatch}>Watch live</button>
      {/if}
    </div>
  </section>
{:else if task.waitingOn.kind === 'github'}
  <section class="next github">
    <div class="head">
      <GitMerge size={18} />
      <div class="grow">
        <div class="kicker caps">
          {held ? 'Do not merge yet' : task.autoVerified ? 'Low-risk change' : 'Checked'}
        </div>
        {#if held}
          <div class="label">
            The branch holds commits nobody verified. Do not merge the pull request until they are
            reviewed.
          </div>
        {:else if task.autoVerified}
          <div class="label">
            Agents and GitHub's checks reviewed it; no person needs to check a change like this.
            {task.autoMergeOn
              ? 'GitHub merges it once its rules are met.'
              : 'It waits for a person to merge it on GitHub.'}
          </div>
        {:else if githubApproved}
          <div class="label">
            Approved on GitHub as @{githubApproved.login}.
            {githubApproved.merge === 'merged'
              ? 'Merged; the task closes itself.'
              : task.autoMergeOn
                ? 'Auto-merge is on: GitHub merges once checks pass and threads are resolved.'
                : 'It waits for a person to merge it there; the task closes itself.'}
          </div>
        {:else if githubFailed}
          <div class="label">
            Approving on GitHub as @{githubFailed.login} failed: approve and merge there.
          </div>
          {#if githubFailed.error}
            <div class="approval faint">{githubFailed.error}</div>
          {/if}
        {:else if session.me?.github}
          <div class="label">
            Approving on GitHub as @{session.me.github.login} once the spec is marked Implemented…
          </div>
        {:else}
          <div class="label">Merge the pull request on GitHub; the task closes itself.</div>
          {#if session.me?.githubAvailable}
            <div class="approval faint">
              <a class="inline" href="/auth/github/start?mode=link" data-sveltekit-reload
                >Connect GitHub</a
              >
              and your next verification approves the pull request on GitHub as you.
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
      {#if task.waitingOn.me}<strong class="you-word"
          >{look.current === 'tecnica' ? 'Your turn' : 'You'}</strong
        >{:else}<UserRound size={18} />{/if}
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
            onclick={() => act({ type: 'accept' }, 'Accepted; an agent writes the plan next')}
          >
            Accept
          </button>
        {/if}
        {#if can('approve') && gate}
          <button class="btn" disabled={busy} onclick={() => (mode = 'changes')}
            >Ask for changes</button
          >
          <button
            class="btn primary"
            disabled={busy}
            onclick={() =>
              act(
                { type: 'approve' },
                gate === 'spec' ? 'Plan approved; it goes to build' : 'Checked'
              )}
          >
            <CircleCheck size={15} />{gate === 'spec'
              ? 'Approve plan'
              : approvesOnGitHub
                ? 'Looks good, approve on GitHub'
                : 'Looks good'}
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
    gap: 14px;
    padding: 16px 0;
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
  }

  /* Waiting on you: the whole block turns yellow, so it cannot be missed or mistaken. */
  .next.mine {
    padding: 16px 18px;
    border: 0;
    background: var(--accent);
    color: var(--accent-text);
  }

  /* A question for you is yellow too, so its text takes the yellow's ink in both themes. */
  .mine .kicker,
  .mine :global(.md) {
    color: var(--accent-text);
  }

  .mine .approval {
    color: var(--accent-text);
    opacity: 0.75;
  }

  .mine .btn {
    border-color: var(--accent-text);
    color: var(--accent-text);
  }

  .mine .btn.primary {
    background: var(--accent-text);
    color: var(--accent);
  }

  .mine .btn:hover:not(:disabled) {
    background: rgba(17, 17, 17, 0.1);
    border-color: var(--accent-text);
  }

  .mine .btn.primary:hover:not(:disabled) {
    background: var(--accent-text);
    text-decoration: underline;
  }

  .mine .btn.ghost {
    border-color: transparent;
  }

  .mine :global(.field) {
    background: rgba(255, 255, 255, 0.55);
    border-bottom-color: var(--accent-text);
    color: var(--accent-text);
  }

  .you-word {
    flex: none;
    font-size: 22px;
    font-weight: 800;
    font-stretch: 75%;
    line-height: 1;
  }

  /* Tecnica: every panel is a ruled box, and waiting on you is a yellow tag, not a yellow field. */
  :global([data-look='tecnica']) .next {
    padding: 14px 16px;
    border: 1.5px solid var(--rule);
    background: var(--panel);
    color: var(--text);
  }

  :global([data-look='tecnica']) .mine .kicker,
  :global([data-look='tecnica']) .mine :global(.md) {
    color: var(--text);
  }

  :global([data-look='tecnica']) .mine .approval {
    color: var(--text-3);
    opacity: 1;
  }

  :global([data-look='tecnica']) .mine .btn {
    border-color: var(--rule);
    color: var(--text);
  }

  :global([data-look='tecnica']) .mine .btn.primary {
    background: var(--rule);
    color: var(--on-ink);
  }

  :global([data-look='tecnica']) .mine .btn:hover:not(:disabled) {
    background: var(--hover);
    text-decoration: none;
  }

  :global([data-look='tecnica']) .mine .btn.primary:hover:not(:disabled) {
    background: var(--text-2);
  }

  :global([data-look='tecnica']) .mine .btn.ghost {
    border-color: transparent;
  }

  :global([data-look='tecnica']) .mine .field {
    background: var(--panel);
    border-color: var(--rule);
    color: var(--text);
  }

  :global([data-look='tecnica']) .you-word {
    padding: 2px 7px;
    background: var(--accent);
    color: var(--accent-text);
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 700;
    font-stretch: normal;
    letter-spacing: 0.04em;
    line-height: 1.4;
    text-transform: uppercase;
  }

  :global([data-look='tecnica']) .label {
    font-size: 14px;
    font-weight: 500;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .head > :global(svg) {
    flex: none;
  }

  .blocked .head {
    align-items: flex-start;
  }

  .grow {
    flex: 1;
    min-width: 0;
  }

  .kicker {
    font-weight: 700;
    color: var(--text-2);
  }

  .label {
    font-size: 15px;
    font-weight: 600;
  }

  .question :global(.md) {
    font-size: 14px;
  }

  .agents {
    display: inline-flex;
    gap: 4px;
  }

  .idle {
    color: var(--text-3);
  }

  .approval {
    font-size: 12.5px;
    margin-top: 2px;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }

  .cancel {
    margin-top: 12px;
  }

  .cancel-row {
    display: flex;
    justify-content: flex-end;
    margin-top: 8px;
  }

  .inline {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .link {
    border: 0;
    background: none;
    padding: 2px 0;
    font-size: 12.5px;
    color: var(--text-3);
  }

  .link:hover {
    color: var(--danger);
    text-decoration: underline;
  }
</style>

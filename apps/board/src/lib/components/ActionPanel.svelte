<script lang="ts">
  import { CircleCheck, CircleHelp, GitMerge, Radio, UserRound } from '@lucide/svelte';
  import { post } from '#lib/api.ts';
  import { stillOpen } from '#lib/checklist.ts';
  import { look } from '#lib/state/look.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { toasts } from '#lib/state/toasts.svelte.ts';
  import type { TaskDetail } from '#lib/types.ts';
  import { taskWork, type SentAction, type TaskAction } from '#lib/working.ts';
  import AgentAvatar from './AgentAvatar.svelte';
  import HandIn from './HandIn.svelte';
  import Markdown from './Markdown.svelte';
  import ProposalNotice from './ProposalNotice.svelte';
  import QuestionOptions from './QuestionOptions.svelte';
  import Working from './Working.svelte';

  interface Props {
    task: TaskDetail;
    /** Reloads the task; says whether the reload landed. */
    onchanged: () => Promise<boolean>;
    onwatch: () => void;
  }

  let { task, onchanged, onwatch }: Props = $props();

  type Mode = 'changes' | 'decline' | 'cancel' | null;
  let mode = $state<Mode>(null);
  let text = $state('');

  /** The action this board sent, shown at work until a reload says where the task is. */
  let sent = $state<SentAction | null>(null);
  /**
   * The task as it stood when the reload after an answer failed to land. That proves nothing about
   * where the task is, so the action stays shown until a later reload replaces the task.
   */
  let heldOver = $state.raw<TaskDetail | null>(null);

  $effect(() => {
    if (!heldOver || task === heldOver) return;
    heldOver = null;
    sent = null;
  });

  // While an action is at work, here or a hand-in on anyone's board, its status line takes the
  // place of the buttons, so nothing is sent twice.
  const work = $derived(taskWork(task, sent));
  const busy = $derived(work !== null);

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
  // A finished task waits only on the learning pull requests it left open.
  const openLearning = $derived(
    task.stage === 'done' ? task.learningPullRequests.filter((pr) => pr.state === 'open') : []
  );
  const gate = $derived(
    task.stage === 'spec_review' ? 'spec' : task.stage === 'verifying' ? 'result' : null
  );
  const approvesOnGitHub = $derived(
    gate === 'result' && Boolean(session.me?.github) && Boolean(task.pullRequest)
  );

  /** Items of the checklist that are not ok yet, said before a "Looks good" passes over them. */
  const open = $derived(gate === 'result' && task.checklist ? stillOpen(task.checklist) : '');
  let confirming = $state(false);
  /** The approve button's label as shown, which the notice of an approval Claude proposed names. */
  const approveLabel = $derived(
    gate === 'spec'
      ? 'Approve plan'
      : confirming
        ? 'Approve anyway'
        : approvesOnGitHub
          ? 'Looks good, approve on GitHub'
          : 'Looks good'
  );

  const approve = () => {
    if (open && !confirming) {
      confirming = true;
      return;
    }
    confirming = false;
    void act({ type: 'approve' }, gate === 'spec' ? 'Plan approved; it goes to build' : 'Checked');
  };

  /**
   * Sends one action and shows it at work until a reload lands: only that says whether it went
   * through, so the buttons never come back on a task the server already moved. Says whether the
   * action was taken.
   */
  const send = async (action: TaskAction, request: () => Promise<string>): Promise<boolean> => {
    if (!session.projectId || work) return false;
    sent = { action, since: new Date().toISOString() };
    let taken = false;
    try {
      toasts.show('ok', await request());
      mode = null;
      text = '';
      taken = true;
    } catch (error) {
      toasts.show('error', (error as Error).message);
    } finally {
      if (await onchanged()) sent = null;
      else heldOver = task;
    }
    return taken;
  };

  const act = (body: { type: TaskAction } & Record<string, string | number>, done: string) =>
    send(body.type, async () => {
      const result = await post<{ stage: string; satisfied?: boolean }>(
        `/api/projects/${session.projectId}/tasks/${task.number}/actions`,
        body
      );
      return result.satisfied === false
        ? 'Approval recorded; more approvals are still needed'
        : done;
    });

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

  // What is written in the answer box goes along as a note on the chosen option, and the version
  // pins the question on screen, so an option never answers a question asked since.
  const choose = (option: string) => {
    if (!task.blocked) return;
    void act(
      { type: 'answer', option, text: text.trim(), version: task.blocked.version },
      'Answer sent; the step runs again'
    );
  };

  const PLACEHOLDERS: Record<Exclude<Mode, null>, string> = {
    changes: 'What should change? The agent works from exactly this.',
    decline: 'Why is this declined? The requester sees it.',
    cancel: 'Why is this cancelled?'
  };
</script>

{#if task.blocked}
  <section class="next blocked" class:mine={task.waitingOn.me && !task.paused && !busy}>
    <div class="head">
      {#if task.waitingOn.me && !task.paused && !busy && look.current === 'tecnica'}<strong
          class="you-word">Question</strong
        >{:else}<CircleHelp size={18} />{/if}
      <div>
        <div class="kicker caps">
          {task.paused ? 'Paused. ' : ''}{task.blocked.needs.length
            ? `Agents cannot go on: for ${task.blocked.askedOf}`
            : `A question for ${task.blocked.askedOf}`}
        </div>
        {#if task.blocked.needs.length}
          <p class="needs">Needs {task.blocked.needs.join(', ')}.</p>
        {/if}
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
    {#if work && mode !== 'cancel'}<Working {work} />{/if}
    {#if can('answer')}
      <form onsubmit={answer} class:away={busy}>
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
      {#if can('submit') && !busy}
        <button class="btn ghost" onclick={submitAsIs}>Submit as is</button>
      {/if}
      {#if session.technical && task.running.length}
        <button class="btn" onclick={onwatch}>Watch live</button>
      {/if}
    </div>
    {#if work && mode !== 'cancel'}<Working {work} />{/if}
  </section>
{:else if task.waitingOn.kind === 'github' && openLearning.length}
  <section class="next github" class:mine={task.waitingOn.me && !busy}>
    <div class="head">
      <GitMerge size={18} />
      <div class="grow">
        <div class="kicker caps">Done; a learning is left to merge</div>
        <div class="label">{task.waitingOn.label}</div>
      </div>
      {#each openLearning as pr (pr.number)}
        <a class="btn" href={pr.url} target="_blank" rel="noopener noreferrer">
          Open #{pr.number}
        </a>
      {/each}
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
              <button
                class="link-button"
                disabled={session.changingAccount}
                onclick={() => session.connectGitHub()}>Connect GitHub</button
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
  <section class="next people" class:mine={task.waitingOn.me && !busy}>
    <div class="head">
      {#if task.waitingOn.me && !busy}<strong class="you-word"
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

    {#if work && mode !== 'cancel'}<Working {work} />{/if}
    <!-- Hidden, not removed, while at work: a hand-in that fails keeps what was written in it. -->
    <div class="controls" class:away={busy}>
      {#if mode === 'changes' || mode === 'decline'}
        <form onsubmit={submitMode}>
          <textarea class="field" bind:value={text} rows="4" placeholder={PLACEHOLDERS[mode]}
          ></textarea>
          <div class="buttons">
            <button type="button" class="btn ghost" onclick={() => (mode = null)}>Back</button>
            <button class="btn primary" disabled={!text.trim()}>
              {mode === 'changes' ? 'Send back' : 'Decline'}
            </button>
          </div>
        </form>
      {:else}
        <div class="buttons">
          {#if can('accept')}
            <button class="btn ghost" onclick={() => (mode = 'decline')}>Decline</button>
            <button
              class="btn primary"
              onclick={() => act({ type: 'accept' }, 'Accepted; an agent writes the plan next')}
            >
              Accept
            </button>
          {/if}
          {#if can('hand_in')}
            <HandIn
              number={task.number}
              branch={task.branch}
              send={(request) => send('hand_in', request)}
            />
          {/if}
          {#if can('hand_back')}
            <button
              class="btn ghost"
              onclick={() => act({ type: 'release' }, 'Handed back; it waits to be built again')}
            >
              Hand the build back
            </button>
          {/if}
          {#if can('claim')}
            <button
              class="btn primary"
              onclick={() => act({ type: 'claim' }, 'Claimed; you build it')}
            >
              Claim the build
            </button>
          {/if}
          {#if can('changes') && gate}
            <button class="btn" onclick={() => (mode = 'changes')}>Ask for changes</button>
          {/if}
          {#if can('approve') && gate}
            {#if task.proposal}
              <ProposalNotice
                proposal={task.proposal}
                approve={approveLabel}
                ondiscard={() => act({ type: 'discard_proposal' }, 'Proposal discarded')}
              />
            {/if}
            {#if confirming}
              <span class="confirm">
                Still open: {open}. They show as such on the pull request.
                <button class="btn ghost" onclick={() => (confirming = false)}>Back</button>
              </span>
            {/if}
            <button class="btn primary" onclick={approve}>
              <CircleCheck size={15} />{approveLabel}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </section>
{/if}

{#if can('cancel') && !['done', 'declined', 'cancelled'].includes(task.stage)}
  {#if mode === 'cancel'}
    <form class="cancel" onsubmit={submitMode}>
      <textarea class="field" bind:value={text} rows="2" placeholder={PLACEHOLDERS.cancel}
      ></textarea>
      {#if work}
        <Working {work} />
      {:else}
        <div class="buttons">
          <button type="button" class="btn ghost" onclick={() => (mode = null)}>Keep it</button>
          <button class="btn danger" disabled={!text.trim()}>Cancel task</button>
        </div>
      {/if}
    </form>
  {:else if !busy}
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

  .needs {
    margin: 4px 0 6px;
    font-size: 13.5px;
    font-weight: 700;
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

  /* The buttons stay where they are, in the section's own layout, and step aside while at work. */
  .controls {
    display: contents;
  }

  .away {
    display: none;
  }

  .cancel {
    margin-top: 12px;
  }

  .cancel-row {
    display: flex;
    justify-content: flex-end;
    margin-top: 8px;
  }

  .confirm {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-2);
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

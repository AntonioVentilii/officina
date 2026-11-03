<script lang="ts">
  import { ExternalLink, GitPullRequest, X } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import { ApiError, get, post } from '$lib/api';
  import { ago, dateTime, money } from '$lib/format';
  import { STAGE_LABELS } from '$lib/stages';
  import { board } from '$lib/state/board.svelte';
  import { clock } from '$lib/state/clock.svelte';
  import { coalesce, live } from '$lib/state/live.svelte';
  import { session } from '$lib/state/session.svelte';
  import { toasts } from '$lib/state/toasts.svelte';
  import type { TaskDetail } from '$lib/types';
  import ActionPanel from './ActionPanel.svelte';
  import ApprovalPlan from './ApprovalPlan.svelte';
  import LearningCard from './LearningCard.svelte';
  import Checklist from './Checklist.svelte';
  import LaneChip from './LaneChip.svelte';
  import Markdown from './Markdown.svelte';
  import MemberAvatar from './MemberAvatar.svelte';
  import RunRow from './RunRow.svelte';
  import StageTrack from './StageTrack.svelte';
  import Timeline from './Timeline.svelte';

  interface Props {
    number: number;
  }

  let { number }: Props = $props();

  type Tab = 'overview' | 'spec' | 'agents' | 'activity';
  let tab = $state<Tab>('overview');
  let task = $state<TaskDetail | null>(null);
  let missing = $state(false);
  let specVersion = $state<number | null>(null);
  let openRuns = $state<Record<string, boolean>>({});
  let comment = $state('');
  let sending = $state(false);

  const load = async () => {
    if (!session.projectId) return;
    try {
      const next = await get<TaskDetail>(`/api/projects/${session.projectId}/tasks/${number}`);
      // Running sessions open themselves the first time they appear.
      for (const run of next.runs) {
        if ((run.status === 'running' || run.status === 'queued') && !(run.id in openRuns))
          openRuns[run.id] = true;
      }
      task = next;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) missing = true;
      else toasts.show('error', (error as Error).message);
    }
  };

  const loadSoon = coalesce(() => void load(), 250);

  $effect(() => {
    void load();
    return live.subscribe((event) => {
      if (
        event.projectId === '*' ||
        (event.projectId === session.projectId && event.number === number)
      )
        loadSoon();
    });
  });

  const close = () => void goto('/', { noScroll: true, keepFocus: true });

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !(event.target instanceof HTMLTextAreaElement)) close();
  };

  const spec = $derived(
    task?.specs.find((item) => item.version === specVersion) ?? task?.specs.at(-1) ?? null
  );
  const cost = $derived(task?.runs.reduce((sum, run) => sum + (run.costCents ?? 0), 0) ?? 0);
  const learned = $derived(board.learnings.filter((item) => item.taskNumber === number));
  const canComment = $derived(task?.actions.includes('comment') ?? false);

  type TabEntry = readonly [Tab, string, string | number | null];
  // Agent runs quote the code, so they are for maintainers and owners; the API sends none otherwise.
  const tabs = $derived<readonly TabEntry[]>(
    task
      ? [
          ['overview', 'Summary', null],
          ['spec', 'Plan', task.specs.length > 1 ? `v${task.specs.at(-1)?.version}` : null],
          ['activity', 'Activity', task.comments.length || null],
          ...(session.technical
            ? ([['agents', 'Agent runs', task.runs.length || null]] as const)
            : [])
        ]
      : []
  );

  const watch = () => {
    tab = 'agents';
    for (const run of task?.runs ?? []) if (run.status === 'running') openRuns[run.id] = true;
  };

  const sendComment = async (event: SubmitEvent) => {
    event.preventDefault();
    const body = comment.trim();
    if (!body || !session.projectId) return;
    sending = true;
    try {
      await post(`/api/projects/${session.projectId}/tasks/${number}/comments`, { body });
      comment = '';
      await load();
    } catch (error) {
      toasts.show('error', (error as Error).message);
    } finally {
      sending = false;
    }
  };

  const onChanged = () => {
    void load();
    void board.refresh();
  };
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" onclick={close} aria-hidden="true"></div>

<aside class="drawer" aria-label="Task {number}">
  {#if missing}
    <div class="missing">
      <p>Task {number} does not exist in this project.</p>
      <button class="btn" onclick={close}>Back to the board</button>
    </div>
  {:else if !task}
    <div class="loading">
      <div class="sk w30"></div>
      <div class="sk w80 tall"></div>
      <div class="sk w100"></div>
    </div>
  {:else}
    <header>
      <div class="bar">
        <span class="number caps num">#{task.number}</span>
        <span class="pill">{STAGE_LABELS[task.stage]}</span>
        <LaneChip lane={task.lane} named />
        <span class="spacer"></span>
        {#if session.technical && task.pullRequestUrl}
          <a class="btn sm" href={task.pullRequestUrl} target="_blank" rel="noopener noreferrer">
            <GitPullRequest size={13} />#{task.pullRequest}<ExternalLink size={11} />
          </a>
        {/if}
        <button class="btn ghost icon" onclick={close} aria-label="Close"><X size={17} /></button>
      </div>
      <h1>{task.title}</h1>
      <div class="track"><StageTrack stage={task.stage} working={task.running.length > 0} /></div>
    </header>

    <div class="scroll">
      <div class="next">
        <ActionPanel {task} onchanged={onChanged} onwatch={watch} />
      </div>

      <nav class="tabs" aria-label="Task sections">
        {#each tabs as [id, label, badge] (id)}
          <button
            class:on={tab === id}
            onclick={() => (tab = id)}
            aria-current={tab === id ? 'page' : undefined}
          >
            {label}{#if badge}<span class="count num">{badge}</span>{/if}
          </button>
        {/each}
      </nav>

      <div class="content">
        {#if tab === 'overview'}
          {#if task.request}
            <section>
              <h3 class="caps">Request</h3>
              <div class="request">
                <div class="who">
                  <MemberAvatar name={task.request.author} size={22} />
                  <strong>{task.request.author}</strong>
                  <time class="faint" title={dateTime(task.request.at)}
                    >{ago(task.request.at, clock.now)}</time
                  >
                </div>
                <Markdown source={task.request.body} />
              </div>
            </section>
          {/if}

          {#if task.checklist?.checklist?.length && (task.stage === 'verifying' || session.technical)}
            <section>
              <h3 class="caps">What to check</h3>
              <Checklist
                items={task.checklist.checklist}
                beforeAfter={task.checklist.beforeAfter ?? []}
                storageKey="officina.check.{session.projectId}.{task.number}.{task.headSha}"
              />
            </section>
          {/if}

          {#if task.plan}
            <details class="more">
              <summary class="caps">Who approves, and why</summary>
              <ApprovalPlan plan={task.plan} />
            </details>
          {/if}

          {#if session.technical && learned.length}
            <section>
              <h3 class="caps">What Officina learned from it</h3>
              <div class="learned">
                {#each learned as learning (learning.id)}
                  <LearningCard {learning} compact />
                {/each}
              </div>
            </section>
          {/if}

          <details class="more">
            <summary class="caps">Details</summary>
            <dl class="facts">
              <dt>Requester</dt>
              <dd><MemberAvatar name={task.requester} size={18} />{task.requester}</dd>
              <dt>Opened</dt>
              <dd title={dateTime(task.createdAt)}>{ago(task.createdAt, clock.now)}</dd>
              <dt>In this stage</dt>
              <dd>since {ago(task.stageSince, clock.now)}</dd>
              <dt>Risk</dt>
              <dd><LaneChip lane={task.lane} showStandard named /></dd>
              <dt>Changes what people see</dt>
              <dd>{task.userVisible ? 'Yes' : 'No'}</dd>
              {#if task.pullRequestUrl}
                <dt>Pull request</dt>
                <dd>
                  <a
                    class="link"
                    href={task.pullRequestUrl}
                    target="_blank"
                    rel="noopener noreferrer">#{task.pullRequest} on GitHub</a
                  >
                </dd>
              {/if}
              {#if session.technical}
                <dt>Agent cost</dt>
                <dd class="num">{money(cost) || '$0.00'}</dd>
              {/if}
              {#if task.fixRounds}
                <dt>Fix rounds</dt>
                <dd>{task.fixRounds}</dd>
              {/if}
              {#if task.headSha && task.repo}
                <dt>Head commit</dt>
                <dd>
                  <a
                    class="mono link"
                    href="https://github.com/{task.repo}/commit/{task.headSha}"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {task.headSha.slice(0, 7)}
                  </a>
                </dd>
              {/if}
            </dl>
          </details>
        {:else if tab === 'spec'}
          {#if spec}
            <div class="spec-head">
              {#if task.specs.length > 1}
                <div class="versions">
                  {#each task.specs as item (item.version)}
                    <button
                      class:on={item.version === spec.version}
                      onclick={() => (specVersion = item.version)}
                    >
                      v{item.version}
                    </button>
                  {/each}
                </div>
              {/if}
              <span class="faint"
                >Version {spec.version} by {spec.author}, {ago(spec.at, clock.now)}</span
              >
            </div>
            <article class="spec"><Markdown source={spec.body} /></article>
          {:else}
            <p class="empty">No plan yet. An agent writes one once the request is accepted.</p>
          {/if}
        {:else if tab === 'agents'}
          {#if task.runs.length}
            <div class="runs">
              {#each [...task.runs].reverse() as run (run.id)}
                <RunRow
                  {run}
                  bind:open={() => openRuns[run.id] ?? false, (value) => (openRuns[run.id] = value)}
                />
              {/each}
            </div>
          {:else}
            <p class="empty">No agent has worked on this task yet.</p>
          {/if}
        {:else}
          <Timeline events={task.events} comments={task.comments} />
          {#if canComment}
            <form class="composer" onsubmit={sendComment}>
              <textarea
                class="field"
                bind:value={comment}
                rows="3"
                placeholder="Add a comment or context."
                onkeydown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
                    event.currentTarget.form?.requestSubmit();
                }}></textarea>
              <div class="composer-bar">
                <span class="faint">⌘ Enter to send</span>
                <button class="btn primary" disabled={sending || !comment.trim()}>Comment</button>
              </div>
            </form>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</aside>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: var(--backdrop);
    animation: fade 0.2s var(--ease);
  }

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 21;
    display: flex;
    flex-direction: column;
    width: min(780px, 100vw);
    background: var(--bg);
    border-left: 1px solid var(--rule);
    animation: enter 0.28s var(--ease);
  }

  header {
    padding: 18px 28px 22px;
    border-bottom: 3px solid var(--rule);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .number {
    font-size: 12px;
    font-weight: 800;
  }

  .bar > :global(.lane) {
    font-size: 13px;
  }

  .spacer {
    flex: 1;
  }

  h1 {
    margin: 14px 0 22px;
    font-size: 36px;
    font-weight: 800;
    font-stretch: 75%;
    line-height: 1.02;
    letter-spacing: -0.01em;
  }

  .scroll {
    flex: 1;
    overflow-y: auto;
  }

  .next {
    padding: 22px 28px 6px;
  }

  .tabs {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    gap: 22px;
    padding: 14px 28px 0;
    background: var(--bg);
    border-bottom: 1px solid var(--rule);
  }

  .tabs button {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    padding: 6px 0 8px;
    border: 0;
    border-bottom: 3px solid transparent;
    margin-bottom: -1px;
    background: none;
    color: var(--text-2);
    font-weight: 600;
    font-size: 14px;
  }

  .tabs button:hover {
    color: var(--text);
  }

  .tabs button.on {
    color: var(--text);
    border-bottom-color: var(--rule);
  }

  .count {
    font-weight: 300;
    font-stretch: 75%;
    font-size: 15px;
  }

  .content {
    padding: 22px 28px 48px;
  }

  section + section,
  section + .more,
  .more + .more {
    margin-top: 30px;
  }

  .more > summary {
    cursor: pointer;
    font-weight: 700;
    color: var(--text-2);
  }

  .more > summary:hover {
    color: var(--text);
  }

  .more[open] > summary {
    margin-bottom: 12px;
  }

  h3 {
    margin: 0 0 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--rule);
    font-weight: 700;
  }

  .who {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 13px;
  }

  .facts {
    display: grid;
    grid-template-columns: 180px 1fr;
    margin: 0;
    font-size: 13.5px;
  }

  dt,
  dd {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }

  dt {
    font-size: 11.5px;
    font-stretch: 85%;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-2);
  }

  dd {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0;
  }

  .link {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .spec-head {
    display: flex;
    align-items: baseline;
    gap: 18px;
    margin-bottom: 14px;
    font-size: 13px;
  }

  .versions {
    display: inline-flex;
    gap: 12px;
  }

  .versions button {
    padding: 2px 0 4px;
    border: 0;
    border-bottom: 3px solid transparent;
    background: none;
    color: var(--text-2);
    font-weight: 600;
    font-size: 13px;
  }

  .versions button.on {
    color: var(--text);
    border-bottom-color: var(--rule);
  }

  .spec {
    padding-top: 6px;
  }

  .learned,
  .runs {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--rule);
  }

  .empty {
    margin: 0;
    padding: 24px 0;
    color: var(--text-3);
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 18px;
    padding-left: 36px;
  }

  .composer-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
  }

  .loading,
  .missing {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 28px;
  }

  .sk {
    height: 14px;
    background: var(--tint);
    animation: signal 1.4s ease-in-out infinite;
  }

  .sk.tall {
    height: 32px;
  }

  .w30 {
    width: 30%;
  }

  .w80 {
    width: 80%;
  }

  .w100 {
    width: 100%;
    height: 120px;
  }

  /* Tecnica: the task is a drawing sheet, a ruled header over the paper. */
  :global([data-look='tecnica']) .drawer {
    border-left-width: 1.5px;
  }

  :global([data-look='tecnica']) header {
    padding: 16px 28px 20px;
    background: var(--panel);
    border-bottom-width: 1.5px;
  }

  :global([data-look='tecnica']) .number {
    font-weight: 400;
  }

  :global([data-look='tecnica']) h1 {
    margin: 12px 0 20px;
    font-size: 24px;
    font-weight: 600;
    font-stretch: normal;
    line-height: 1.25;
    letter-spacing: 0;
  }

  :global([data-look='tecnica']) .tabs {
    background: var(--bg);
    border-bottom-width: 1.5px;
  }

  :global([data-look='tecnica']) .tabs button {
    font-family: var(--font-display);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: 13px;
  }

  :global([data-look='tecnica']) .count {
    font-family: var(--font-num);
    font-weight: 400;
    font-size: 12px;
  }

  :global([data-look='tecnica']) h3 {
    border-bottom-width: 1.5px;
  }

  :global([data-look='tecnica']) dt {
    font-size: 11px;
    font-stretch: normal;
    letter-spacing: 0.02em;
    font-family: var(--font-num);
  }

  :global([data-look='tecnica']) .spec {
    padding: 20px 24px;
    border: 1.5px solid var(--rule);
    background: var(--panel);
  }

  @keyframes enter {
    from {
      transform: translateX(32px);
      opacity: 0;
    }
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }

  @media (max-width: 720px) {
    header,
    .next,
    .content {
      padding-left: 16px;
      padding-right: 16px;
    }

    h1 {
      font-size: 28px;
    }

    .tabs {
      padding: 10px 16px 0;
      overflow-x: auto;
    }

    .facts {
      grid-template-columns: 120px 1fr;
    }

    .composer {
      padding-left: 0;
    }
  }
</style>

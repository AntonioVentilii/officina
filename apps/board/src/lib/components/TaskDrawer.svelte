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
  // Agent runs are for whoever looks after the work; anyone gets there through Watch live.
  const tabs = $derived<readonly TabEntry[]>(
    task
      ? [
          ['overview', 'Summary', null],
          ['spec', 'Plan', task.specs.length > 1 ? `v${task.specs.at(-1)?.version}` : null],
          ['activity', 'Activity', task.comments.length || null],
          ...(session.technical || tab === 'agents'
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
        <span class="number mono">#{task.number}</span>
        <span class="pill">{STAGE_LABELS[task.stage]}</span>
        <LaneChip lane={task.lane} />
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
              <h3>Request</h3>
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
              <h3>What to check</h3>
              <Checklist
                items={task.checklist.checklist}
                beforeAfter={task.checklist.beforeAfter ?? []}
                storageKey="officina.check.{session.projectId}.{task.number}.{task.headSha}"
              />
            </section>
          {/if}

          {#if task.plan}
            <details class="more">
              <summary>Who approves, and why</summary>
              <ApprovalPlan plan={task.plan} />
            </details>
          {/if}

          {#if session.technical && learned.length}
            <section>
              <h3>What Officina learned from it</h3>
              <div class="learned">
                {#each learned as learning (learning.id)}
                  <LearningCard {learning} compact />
                {/each}
              </div>
            </section>
          {/if}

          <details class="more">
            <summary>Details</summary>
            <dl class="facts">
              <dt>Requester</dt>
              <dd><MemberAvatar name={task.requester} size={18} />{task.requester}</dd>
              <dt>Opened</dt>
              <dd title={dateTime(task.createdAt)}>{ago(task.createdAt, clock.now)}</dd>
              <dt>In this stage</dt>
              <dd>since {ago(task.stageSince, clock.now)}</dd>
              <dt>Risk</dt>
              <dd><LaneChip lane={task.lane} showStandard /></dd>
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
              <dt>Agent cost</dt>
              <dd class="num">{money(cost) || '$0.00'}</dd>
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
    backdrop-filter: blur(2px);
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
    width: min(760px, 100vw);
    background: var(--bg);
    border-left: 1px solid var(--border-strong);
    box-shadow: var(--shadow-lg);
    animation: enter 0.28s var(--ease);
  }

  header {
    padding: 14px 22px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .number {
    color: var(--text-3);
    font-size: 13px;
  }

  .spacer {
    flex: 1;
  }

  h1 {
    margin: 10px 0 18px;
    font-size: 20px;
    font-weight: 650;
    line-height: 1.3;
    letter-spacing: -0.015em;
  }

  .scroll {
    flex: 1;
    overflow-y: auto;
  }

  .next {
    padding: 18px 22px 4px;
  }

  .tabs {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    gap: 2px;
    padding: 10px 22px 0;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }

  .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px 10px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--text-2);
    font-weight: 550;
    font-size: 13px;
  }

  .tabs button:hover {
    color: var(--text);
  }

  .tabs button.on {
    color: var(--text);
    border-bottom-color: var(--accent);
  }

  .count {
    padding: 0 6px;
    border-radius: 999px;
    font-size: 11px;
    background: var(--panel-3);
    color: var(--text-2);
  }

  .content {
    padding: 18px 22px 40px;
  }

  section + section,
  section + .more,
  .more + .more {
    margin-top: 26px;
  }

  .more > summary {
    cursor: pointer;
    font-size: 11.5px;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
  }

  .more[open] > summary {
    margin-bottom: 10px;
  }

  h3 {
    margin: 0 0 10px;
    font-size: 11.5px;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
  }

  .request {
    padding: 12px 16px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--panel);
  }

  .who {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 12.5px;
  }

  .facts {
    display: grid;
    grid-template-columns: 170px 1fr;
    gap: 9px 12px;
    margin: 0;
    font-size: 13px;
  }

  dt {
    color: var(--text-3);
  }

  dd {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0;
  }

  .link {
    color: var(--info);
  }

  .spec-head {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
    font-size: 12.5px;
  }

  .versions {
    display: inline-flex;
    padding: 2px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .versions button {
    height: 24px;
    padding: 0 9px;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--text-2);
    font-size: 12px;
  }

  .versions button.on {
    background: var(--panel-3);
    color: var(--text);
  }

  .spec {
    padding: 20px 24px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--panel);
  }

  .learned {
    display: flex;
    flex-direction: column;
    gap: 8px;
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

  .composer {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 16px;
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
    gap: 12px;
    padding: 24px;
  }

  .sk {
    height: 14px;
    border-radius: 5px;
    background: linear-gradient(90deg, var(--panel-2), var(--panel-3), var(--panel-2));
    background-size: 200% 100%;
    animation: shimmer 1.4s linear infinite;
  }

  .sk.tall {
    height: 24px;
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

    .tabs {
      padding: 8px 16px 0;
      overflow-x: auto;
    }

    .facts {
      grid-template-columns: 110px 1fr;
    }

    .spec {
      padding: 14px 16px;
    }

    .composer {
      padding-left: 0;
    }
  }
</style>

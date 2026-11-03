<script lang="ts">
  import { ago, dateTime } from '$lib/format';
  import { STAGE_LABELS } from '$lib/stages';
  import type { Comment, Stage, TaskEvent } from '$lib/types';
  import AgentAvatar from './AgentAvatar.svelte';
  import Markdown from './Markdown.svelte';
  import MemberAvatar from './MemberAvatar.svelte';
  import { clock } from '$lib/state/clock.svelte';

  interface Props {
    events: readonly TaskEvent[];
    comments: readonly Comment[];
  }

  let { events, comments }: Props = $props();

  const stage = (value: unknown) => STAGE_LABELS[value as Stage] ?? String(value);
  const GATES: Record<string, string> = { spec_review: 'the spec', verifying: 'the result' };

  const sentence = (event: TaskEvent): string | null => {
    const p = event.payload;
    switch (event.type) {
      case 'created':
        return 'opened the request';
      case 'stage_changed':
        return `moved it to ${stage(p.to)}`;
      case 'spec_versioned':
        return `wrote spec version ${p.version}`;
      case 'lane_changed':
        return p.from
          ? `moved it from the ${p.from} lane to ${p.to}`
          : `put it in the ${p.to} lane`;
      case 'user_visible_changed':
        return p.userVisible
          ? 'marked it as a user-visible change'
          : 'marked it as not user-visible';
      case 'approval_recorded':
        return `approved ${GATES[String(p.gate)] ?? p.gate}${p.satisfied ? '' : ', more approvals needed'}`;
      case 'changes_requested':
        return 'asked for changes';
      case 'assigned':
        return null;
      case 'pushed':
        return `pushed ${String(p.headSha).slice(0, 7)} (${p.diffLines} lines in ${(p.changedPaths as string[]).length} files)`;
      case 'review_recorded':
        return p.verdict === 'approve' ? 'approved the change' : 'asked for changes';
      case 'guardrail_tripped':
        return `stopped it: ${p.details}`;
      case 'ci_failed':
        return 'reported failing checks';
      case 'blocked':
        return 'asked a question';
      case 'unblocked':
        return 'answered the question';
      case 'paused':
        return 'paused it';
      case 'resumed':
        return 'resumed it';
      case 'closed':
        return `${p.stage === 'declined' ? 'declined' : 'cancelled'} it: ${p.reason}`;
      case 'spec_status_set':
        return `set the spec status to ${p.status}`;
      case 'github_approved':
        return p.merge === 'merged'
          ? `approved and merged the pull request on GitHub as @${p.login}`
          : `approved the pull request on GitHub as @${p.login} and turned on auto-merge`;
      case 'github_approval_failed':
        return `could not approve on GitHub as @${p.login}: ${p.error}`;
      case 'checklist_posted':
        return `posted the checklist on pull request #${p.pullRequest}`;
      default:
        return event.type.replaceAll('_', ' ');
    }
  };

  const detail = (event: TaskEvent): string | null => {
    const p = event.payload;
    if (event.type === 'changes_requested') return String(p.note ?? '');
    if (event.type === 'review_recorded') return String(p.notes ?? '');
    if (event.type === 'blocked')
      return String((p.blocked as { question?: string })?.question ?? '');
    return null;
  };

  type Item =
    | { kind: 'event'; at: string; event: TaskEvent; texts: string[]; details: string[] }
    | { kind: 'comment'; at: string; comment: Comment };

  const join = (parts: readonly string[]) =>
    parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;

  // What one actor did at one moment reads as one sentence: "wrote spec version 1, put it in the
  // green lane and moved it to Spec review".
  const items = $derived.by(() => {
    const sorted: Item[] = [
      ...events.flatMap((event): Item[] => {
        const text = sentence(event);
        const extra = detail(event);
        return text
          ? [{ kind: 'event', at: event.at, event, texts: [text], details: extra ? [extra] : [] }]
          : [];
      }),
      ...comments.map((comment): Item => ({ kind: 'comment', at: comment.at, comment }))
    ].sort((a, b) => a.at.localeCompare(b.at));
    const grouped: Item[] = [];
    for (const item of sorted) {
      const last = grouped.at(-1);
      if (
        item.kind === 'event' &&
        last?.kind === 'event' &&
        last.event.actor === item.event.actor &&
        Math.abs(new Date(item.at).getTime() - new Date(last.at).getTime()) < 2000
      ) {
        last.texts.push(...item.texts);
        last.details.push(...item.details);
      } else {
        grouped.push(item);
      }
    }
    return grouped;
  });
</script>

<ol class="timeline">
  {#each items as item (item.kind === 'event' ? `e${item.event.id}` : `c${item.comment.id}`)}
    {#if item.kind === 'comment'}
      <li class="comment">
        <span class="rail"><MemberAvatar name={item.comment.author} size={24} /></span>
        <div class="bubble">
          <div class="meta">
            <strong>{item.comment.author}</strong>
            <time class="faint" datetime={item.at} title={dateTime(item.at)}
              >{ago(item.at, clock.now)}</time
            >
          </div>
          <Markdown source={item.comment.body} />
        </div>
      </li>
    {:else}
      <li class="event">
        <span class="rail">
          {#if item.event.actorKind === 'agent'}
            <AgentAvatar role={item.event.actorRole ?? ''} label={item.event.actor} size={20} />
          {:else if item.event.actorKind === 'member'}
            <MemberAvatar name={item.event.actor} size={20} />
          {:else}
            <span class="engine"></span>
          {/if}
        </span>
        <div class="line">
          <span><strong>{item.event.actor}</strong> {join(item.texts)}</span>
          <time class="faint" datetime={item.at} title={dateTime(item.at)}
            >{ago(item.at, clock.now)}</time
          >
          {#each item.details as extra, index (index)}
            <details class="more">
              <summary>Details</summary>
              <Markdown source={extra} />
            </details>
          {/each}
        </div>
      </li>
    {/if}
  {/each}
</ol>

<style>
  .timeline {
    position: relative;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .timeline::before {
    content: '';
    position: absolute;
    top: 8px;
    bottom: 8px;
    left: 11px;
    width: 1px;
    background: var(--rule);
  }

  li {
    position: relative;
    display: flex;
    gap: 14px;
    padding: 7px 0;
  }

  .rail {
    display: grid;
    place-items: start center;
    flex: none;
    width: 24px;
    z-index: 1;
    background: var(--bg);
  }

  /* Officina itself: a short bar across the rail, neither a person nor an agent. */
  .engine {
    width: 12px;
    height: 3px;
    margin-top: 9px;
    background: var(--text);
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 10px;
    font-size: 13px;
    color: var(--text-2);
    padding-top: 1px;
  }

  .line strong {
    color: var(--text);
    font-weight: 700;
  }

  time {
    font-size: 12px;
    font-stretch: 85%;
    letter-spacing: 0.04em;
  }

  .more {
    flex-basis: 100%;
    margin-top: 4px;
  }

  .more summary {
    cursor: pointer;
    font-size: 11.5px;
    font-stretch: 85%;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-2);
  }

  .more :global(.md) {
    margin-top: 6px;
    padding: 2px 0 2px 12px;
    border-left: 2px solid var(--rule);
    font-size: 13px;
  }

  .bubble {
    flex: 1;
    min-width: 0;
    padding: 10px 0 12px;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }

  .bubble .meta {
    display: flex;
    gap: 10px;
    align-items: baseline;
    margin-bottom: 4px;
    font-size: 13px;
  }
</style>

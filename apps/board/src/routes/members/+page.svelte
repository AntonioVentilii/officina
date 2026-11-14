<script lang="ts">
  import { goto } from '$app/navigation';
  import { Copy, Link, Plug } from '@lucide/svelte';
  import { get, post } from '$lib/api';
  import MemberAvatar from '$lib/components/MemberAvatar.svelte';
  import { ago, dateTime } from '$lib/format';
  import { latestOnly } from '$lib/latest';
  import { board } from '$lib/state/board.svelte';
  import { clock } from '$lib/state/clock.svelte';
  import { session } from '$lib/state/session.svelte';
  import { toasts } from '$lib/state/toasts.svelte';
  import type { AccessEvent, MemberActivity } from '$lib/types';

  /** Fresh links by member id, shown until the page is left: the server keeps only their hash. */
  let links = $state<Record<string, { readonly url: string; readonly validDays: number }>>({});
  let busy = $state<string | null>(null);

  const linkText = (link: MemberActivity['link']): string => {
    if (!link) return 'No link on record';
    if (link.usedAt) return `Used ${ago(link.usedAt, clock.now)}`;
    if (link.state === 'expired') return `Expired ${ago(link.expiresAt, clock.now)}`;
    return `Pending, valid until ${dateTime(link.expiresAt)}`;
  };

  const sendLink = async (member: MemberActivity) => {
    if (!session.projectId) return;
    busy = member.id;
    try {
      const link = await post<{ url: string; validDays: number }>(
        `/api/projects/${session.projectId}/members/${member.id}/link`
      );
      links = { ...links, [member.id]: link };
      await board.refresh();
    } catch (error) {
      toasts.show('error', (error as Error).message);
    } finally {
      busy = null;
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toasts.show('ok', 'Link copied');
    } catch {
      toasts.show('error', 'Copy failed; select the link and copy it by hand');
    }
  };

  // Owners only: who signed in, who sent links and which apps act for whom.
  let accessLog = $state<readonly AccessEvent[] | null>(null);
  // A slow answer for a project no longer selected must not replace the selected one's log.
  const latestLog = latestOnly();
  $effect(() => {
    const projectId = session.projectId;
    const stale = latestLog();
    accessLog = null;
    if (!projectId || !session.can('see_access_log')) return;
    get<{ events: AccessEvent[] }>(`/api/projects/${projectId}/access-log`)
      .then((answer) => {
        if (!stale()) accessLog = answer.events;
      })
      .catch((error: Error) => {
        if (!stale()) toasts.show('error', error.message);
      });
  });

  // Maintainers' page: the API refuses its data to anyone else.
  $effect(() => {
    if (session.project && !session.technical) void goto('/', { replaceState: true });
  });
</script>

<div class="page">
  <header>
    <h1 class="page-title">Members</h1>
    <p class="muted">
      Who is in this project and how far each person got: whether they used their invite, when they
      last opened the board and whether they added Officina to Claude. Owners can send a fresh link
      to someone who has not signed in yet; send it to them yourself, it works once.
    </p>
  </header>

  <ul class="list">
    {#each board.members as member (member.id)}
      <li>
        <div class="row">
          <MemberAvatar name={member.name} size={26} />
          <div class="who">
            <span class="name">{member.name}</span>
            <span class="role caps"
              >{member.role}{#if member.domains.length}, {member.domains.join(', ')}{/if}</span
            >
          </div>
          <div class="fact">
            <span class="label caps">Joined</span>
            {member.firstSignedInAt ? ago(member.firstSignedInAt, clock.now) : 'Not yet'}
          </div>
          <div class="fact">
            <span class="label caps">Latest link</span>
            <span class:muted={member.link?.state === 'expired'}>{linkText(member.link)}</span>
          </div>
          <div class="fact">
            <span class="label caps">Last seen</span>
            {member.lastSeenAt ? ago(member.lastSeenAt, clock.now) : 'No open session'}
          </div>
          <div class="fact claude" title="Officina added to Claude as a connector">
            <Plug size={14} />{member.claudeConnected ? 'Claude connected' : 'No Claude'}
          </div>
          {#if member.invitable}
            <button class="btn sm" disabled={busy === member.id} onclick={() => sendLink(member)}>
              <Link size={14} />New invite link
            </button>
          {/if}
        </div>
        {#if links[member.id]}
          {@const fresh = links[member.id]!}
          <div class="fresh">
            <input class="field" readonly value={fresh.url} aria-label="Invite link" />
            <button class="btn sm" onclick={() => copy(fresh.url)}>
              <Copy size={14} />Copy
            </button>
            <span class="muted">Valid {fresh.validDays} days, works once.</span>
          </div>
        {/if}
      </li>
    {/each}
  </ul>

  {#if accessLog}
    <section class="log">
      <h2>Access log</h2>
      <p class="muted">
        Sign-ins and sign-outs, sign-in links and who sent them, GitHub accounts, and the apps each
        member let act as them through the Claude connector. Kept for a year.
      </p>
      {#if accessLog.length === 0}
        <p class="muted">Nothing yet.</p>
      {:else}
        <ol>
          {#each accessLog as event (event.id)}
            <li>
              <time class="num" datetime={event.at} title={dateTime(event.at)}
                >{ago(event.at, clock.now)}</time
              >
              <span><strong>{event.member}</strong> {event.text}</span>
            </li>
          {/each}
        </ol>
      {/if}
    </section>
  {/if}
</div>

<style>
  .page {
    height: 100%;
    overflow-y: auto;
    padding-bottom: 48px;
  }

  header {
    padding: 28px 32px 22px;
    border-bottom: 3px solid var(--rule);
  }

  header p {
    margin: 10px 0 0;
    max-width: 560px;
  }

  .list {
    max-width: 1040px;
    margin: 12px 32px 0;
    padding: 0;
    list-style: none;
  }

  li {
    border-bottom: 1px solid var(--border);
  }

  .row {
    display: grid;
    /* Fixed trailing columns keep every row aligned, with or without the link button. */
    grid-template-columns: 26px minmax(120px, 1fr) repeat(3, minmax(0, 1fr)) 120px 150px;
    align-items: center;
    gap: 16px;
    padding: 13px 4px;
  }

  .who,
  .fact {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    font-size: 13.5px;
  }

  .name {
    font-size: 15px;
    font-weight: 600;
  }

  .role,
  .label {
    font-size: 11px;
    color: var(--text-2);
  }

  .claude {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    color: var(--text-2);
  }

  .row .btn {
    justify-self: end;
  }

  .fresh {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 0 4px 13px 42px;
  }

  .fresh .field {
    flex: 1 1 320px;
    font-family: var(--font-mono);
    font-size: 12.5px;
  }

  .log {
    max-width: 1040px;
    margin: 36px 32px 0;
  }

  .log h2 {
    margin: 0;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--rule);
    font-size: 22px;
    font-weight: 800;
    font-stretch: 75%;
  }

  .log > p {
    margin: 10px 0;
    max-width: 560px;
  }

  .log ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .log li {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    gap: 16px;
    padding: 9px 4px;
    border-bottom: 1px solid var(--border);
    font-size: 13.5px;
  }

  .log time {
    color: var(--text-2);
  }

  /* Tecnica: a ruled header strip and a ruled list on panels. */
  :global([data-look='tecnica']) :is(header, .list) {
    background: var(--panel);
  }

  :global([data-look='tecnica']) header {
    padding: 18px 24px;
    border-bottom-width: 1.5px;
  }

  :global([data-look='tecnica']) .list {
    border: 1.5px solid var(--rule);
  }

  :global([data-look='tecnica']) .row {
    padding: 11px 12px;
  }

  @media (max-width: 720px) {
    .list {
      margin: 12px 16px 0;
    }

    .log {
      margin: 28px 16px 0;
    }

    .log li {
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
    }

    header {
      padding: 20px 16px 16px;
    }

    header :global(.page-title) {
      font-size: 56px;
    }

    .row {
      grid-template-columns: 26px minmax(0, 1fr);
    }

    .fact,
    .row .btn {
      grid-column: 2;
    }

    .fresh {
      padding-left: 4px;
    }
  }
</style>

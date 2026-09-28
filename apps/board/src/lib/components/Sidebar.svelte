<script lang="ts">
  import {
    Bot,
    GitMerge,
    GraduationCap,
    Inbox,
    LogOut,
    Monitor,
    Moon,
    SquareKanban,
    Sun
  } from '@lucide/svelte';
  import { page } from '$app/state';
  import { board } from '$lib/state/board.svelte';
  import { live } from '$lib/state/live.svelte';
  import { session } from '$lib/state/session.svelte';
  import MemberAvatar from './MemberAvatar.svelte';

  interface Props {
    theme: 'system' | 'dark' | 'light';
    oncycletheme: () => void;
  }

  let { theme, oncycletheme }: Props = $props();

  const path = $derived(page.url.pathname);
  const onBoard = $derived(path === '/' || path.startsWith('/tasks'));

  const LIVE_LABELS = { live: 'Live', connecting: 'Reconnecting', offline: 'Offline' } as const;
</script>

<nav class="sidebar" aria-label="Main">
  <a class="brand" href="/">
    <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--panel-3)" />
      <path d="M8 13h13l3-3h2v4l-3 2H19v3l3 5H10l3-5v-3H8z" fill="var(--accent)" />
    </svg>
    <span>Officina</span>
  </a>

  {#if session.me && session.me.projects.length > 1}
    <select
      class="project field"
      value={session.projectId}
      onchange={(event) => session.selectProject(event.currentTarget.value)}
      aria-label="Project"
    >
      {#each session.me.projects as project (project.id)}
        <option value={project.id}>{project.repo}</option>
      {/each}
    </select>
  {:else if session.project}
    <div class="project-name mono" title={session.project.repo}>{session.project.repo}</div>
  {/if}

  <ul class="nav">
    <li>
      <a href="/" class:on={onBoard}><SquareKanban size={16} />Board</a>
    </li>
    <li>
      <a href="/inbox" class:on={path === '/inbox'}>
        <Inbox size={16} />Inbox
        {#if board.waitingOnMe.length}<span class="badge num">{board.waitingOnMe.length}</span>{/if}
      </a>
    </li>
    <li>
      <a href="/agents" class:on={path === '/agents'}>
        <Bot size={16} />Agents
        {#if board.running.length}<span class="running num"
            ><span class="pulse"></span>{board.running.length}</span
          >{/if}
      </a>
    </li>
    <li>
      <a href="/learnings" class:on={path === '/learnings'}>
        <GraduationCap size={16} />Learnings
        {#if board.proposedLearnings.length}<span class="badge quiet num"
            >{board.proposedLearnings.length}</span
          >{/if}
      </a>
    </li>
  </ul>

  <div class="bottom">
    <div class="live {live.status}" title="Realtime updates">
      <span class="dot"></span>{LIVE_LABELS[live.status]}
    </div>
    {#if session.me?.githubAvailable}
      {#if session.me.github}
        <div class="github faint" title="Approvals you give here also approve on GitHub as you">
          <GitMerge size={13} />@{session.me.github.login}
        </div>
      {:else}
        <a class="github connect" href="/auth/github/start?mode=link" data-sveltekit-reload>
          <GitMerge size={13} />Connect GitHub
        </a>
      {/if}
    {/if}
    {#if session.me}
      <div class="me">
        <MemberAvatar name={session.me.member.name} size={26} />
        <div class="who">
          <span class="name">{session.me.member.name}</span>
          <span class="role faint">{session.project?.role ?? ''}</span>
        </div>
        <button
          class="btn ghost icon sm"
          onclick={oncycletheme}
          title="Theme: {theme}"
          aria-label="Theme: {theme}"
        >
          {#if theme === 'dark'}<Moon size={14} />{:else if theme === 'light'}<Sun
              size={14}
            />{:else}<Monitor size={14} />{/if}
        </button>
        <button
          class="btn ghost icon sm"
          onclick={() => session.signOut()}
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut size={14} />
        </button>
      </div>
    {/if}
  </div>
</nav>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 14px;
    height: 100%;
    padding: 16px 12px 12px;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--border);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 2px 6px;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .project {
    height: 32px;
    padding: 0 8px;
    font-size: 12.5px;
  }

  .project-name {
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .nav a {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-weight: 500;
  }

  .nav a:hover {
    background: var(--hover);
    color: var(--text);
  }

  .nav a.on {
    background: var(--panel-3);
    color: var(--text);
  }

  .badge {
    margin-left: auto;
    min-width: 19px;
    height: 19px;
    padding: 0 6px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
    line-height: 19px;
    text-align: center;
    background: var(--accent);
    color: var(--accent-text);
  }

  .badge.quiet {
    background: var(--panel-3);
    color: var(--text-2);
  }

  .running {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    font-size: 11.5px;
    color: var(--accent);
  }

  .pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.4s ease-in-out infinite;
  }

  .bottom {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .live {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 8px;
    font-size: 11.5px;
    color: var(--text-3);
  }

  .live .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-3);
  }

  .live.live .dot {
    background: var(--ok);
    box-shadow: 0 0 0 3px var(--ok-soft);
  }

  .live.connecting .dot {
    background: var(--warn);
    animation: pulse 1.2s infinite;
  }

  .live.offline .dot {
    background: var(--danger);
  }

  .github {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 8px;
    font-size: 11.5px;
  }

  .github.connect {
    height: 30px;
    border-radius: var(--radius-sm);
    border: 1px dashed var(--border-strong);
    color: var(--text-2);
  }

  .github.connect:hover {
    color: var(--text);
    border-color: var(--accent);
  }

  .me {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 6px 2px 8px;
    border-top: 1px solid var(--border);
  }

  .who {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    line-height: 1.25;
  }

  .name {
    font-size: 12.5px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .role {
    font-size: 11px;
    text-transform: capitalize;
  }

  /* On phones the sidebar becomes a tab bar along the bottom edge. */
  @media (max-width: 720px) {
    .sidebar {
      flex-direction: row;
      align-items: center;
      height: auto;
      gap: 4px;
      padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
      border-right: 0;
      border-top: 1px solid var(--border);
    }

    .brand,
    .github,
    .project,
    .project-name,
    .live,
    .me :global(.avatar),
    .who {
      display: none;
    }

    .nav {
      flex: 1;
      flex-direction: row;
      justify-content: space-around;
    }

    .nav a {
      position: relative;
      flex-direction: column;
      gap: 2px;
      height: auto;
      padding: 6px 12px;
      font-size: 11px;
    }

    .nav a.on {
      background: none;
      color: var(--accent);
    }

    .badge,
    .running {
      position: absolute;
      top: 0;
      right: 2px;
      margin: 0;
    }

    .badge {
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      font-size: 10px;
      line-height: 16px;
    }

    .running {
      font-size: 10px;
    }

    .bottom {
      margin: 0;
    }

    .me {
      gap: 2px;
      padding: 0;
      border: 0;
    }
  }
</style>

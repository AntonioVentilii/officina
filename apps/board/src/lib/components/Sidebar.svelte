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
  import { LOOKS, look } from '$lib/state/look.svelte';
  import { session } from '$lib/state/session.svelte';
  import Logo from './Logo.svelte';
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
    <Logo />
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
    <div class="project-name caps" title={session.project.repo}>{session.project.repo}</div>
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
    {#if session.technical}
      <li>
        <a href="/agents" class:on={path === '/agents'}>
          <Bot size={16} />Agents
          {#if board.running.length}<span class="running num"
              ><span class="pulse"></span>{board.running.length} at work</span
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
    {/if}
  </ul>

  <div class="bottom">
    <div class="live {live.status}" title="Realtime updates">
      <span class="dot"></span>{LIVE_LABELS[live.status]}
    </div>
    {#if session.me?.githubAvailable}
      {#if session.me.github}
        <div class="github" title="Approvals you give here also approve on GitHub as you">
          <GitMerge size={13} />@{session.me.github.login}
        </div>
      {:else}
        <a class="github connect" href="/auth/github/start?mode=link" data-sveltekit-reload>
          <GitMerge size={13} />Connect GitHub
        </a>
      {/if}
    {/if}
    <div class="looks" role="group" aria-label="Look">
      {#each LOOKS as item (item.id)}
        <button
          class:on={look.current === item.id}
          aria-pressed={look.current === item.id}
          disabled={look.switching}
          onclick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            look.choose(item.id, { x: box.left + box.width / 2, y: box.top + box.height / 2 });
          }}
        >
          <Logo look={item.id} size={14} />{item.label}
        </button>
      {/each}
    </div>
    {#if session.me}
      <div class="me">
        <MemberAvatar name={session.me.member.name} size={26} />
        <div class="who">
          <span class="name">{session.me.member.name}</span>
          <span class="role caps">{session.project?.role ?? ''}</span>
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
    height: 100%;
    padding: 28px 0 16px;
    background: var(--nav-bg);
    color: var(--nav-text);
    border-right: 1px solid var(--nav-rule);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 24px 26px;
    font-size: 24px;
    font-weight: 800;
    font-stretch: 72%;
    letter-spacing: -0.01em;
    line-height: 1;
  }

  .project {
    width: auto;
    margin: 0 24px 18px;
    height: 32px;
    padding: 0 8px;
    font-size: 12.5px;
    color: var(--nav-text);
    background: transparent;
    border-bottom-color: var(--nav-text-2);
  }

  .project option {
    color: initial;
  }

  .project-name {
    padding: 0 24px 20px;
    font-size: 12px;
    color: var(--nav-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .nav {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .nav a {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 24px 11px 20px;
    border-left: 4px solid transparent;
    color: var(--nav-text-2);
    font-size: 15px;
    font-weight: 500;
  }

  .nav a:hover {
    color: var(--nav-text);
  }

  .nav a.on {
    border-left-color: var(--nav-text);
    color: var(--nav-text);
    font-weight: 700;
  }

  .badge {
    margin-left: auto;
    min-width: 22px;
    padding: 0 7px;
    font-size: 13px;
    font-weight: 800;
    line-height: 22px;
    text-align: center;
    background: var(--accent);
    color: var(--accent-text);
  }

  .badge.quiet {
    min-width: 0;
    padding: 0;
    font-weight: 400;
    background: none;
    color: var(--nav-text-2);
  }

  .running {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-left: auto;
    font-size: 13px;
    font-weight: 400;
    color: var(--nav-text-2);
  }

  .pulse {
    width: 8px;
    height: 8px;
    background: var(--nav-text);
    animation: signal 1.2s ease-in-out infinite;
  }

  .bottom {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-top: 16px;
  }

  .live,
  .github {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 24px;
    font-size: 11.5px;
    font-stretch: 85%;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--nav-text-2);
  }

  .live .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 2px solid var(--nav-text-2);
  }

  .live.live .dot {
    border-color: var(--nav-text);
    background: var(--nav-text);
  }

  .live.connecting .dot {
    animation: signal 1.2s infinite;
  }

  .live.offline {
    color: var(--danger);
  }

  .live.offline .dot {
    border-color: var(--danger);
    background: var(--danger);
  }

  .github {
    text-transform: none;
    letter-spacing: 0.02em;
  }

  .github.connect {
    color: var(--nav-text);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .looks {
    display: flex;
    gap: 16px;
    padding: 0 24px;
  }

  .looks button {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 2px 0 4px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--nav-text-2);
    font-size: 12.5px;
  }

  .looks button:hover {
    color: var(--nav-text);
  }

  /* Locked only while the looks swap: dimming it would show up in the animation itself. */
  .looks button:disabled {
    cursor: progress;
  }

  .looks button.on {
    color: var(--nav-text);
    border-bottom-color: var(--nav-text);
  }

  .me {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 4px;
    padding: 16px 16px 0 24px;
    border-top: 1px solid var(--nav-rule);
  }

  .who {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    gap: 2px;
    line-height: 1.2;
  }

  .name {
    font-size: 14px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .role {
    font-size: 11px;
    color: var(--nav-text-2);
  }

  .me .btn {
    color: var(--nav-text-2);
  }

  .me .btn:hover {
    color: var(--nav-text);
    background: none;
  }

  /* Tecnica: a light panel ruled off from the board, with a title-block brand row. */
  :global([data-look='tecnica']) .sidebar {
    padding: 0 0 14px;
    border-right-width: 1.5px;
  }

  :global([data-look='tecnica']) .brand {
    gap: 10px;
    padding: 18px 20px;
    border-bottom: 1.5px solid var(--nav-rule);
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  :global([data-look='tecnica']) .project-name {
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    text-transform: none;
  }

  :global([data-look='tecnica']) .project {
    margin: 12px 20px;
  }

  :global([data-look='tecnica']) .nav {
    padding: 8px 0;
  }

  :global([data-look='tecnica']) .nav a {
    padding: 10px 20px;
    border: 0;
    border-top: 1px solid transparent;
    border-bottom: 1px solid transparent;
    color: var(--nav-text);
    font-size: 14px;
  }

  :global([data-look='tecnica']) .nav a.on {
    background: var(--bg);
    border-color: var(--border);
    font-weight: 600;
  }

  :global([data-look='tecnica']) .badge {
    min-width: 0;
    padding: 0 6px;
    font-size: 12px;
    font-weight: 500;
    line-height: 20px;
  }

  :global([data-look='tecnica']) .badge.quiet {
    padding: 0;
    color: var(--nav-text);
  }

  :global([data-look='tecnica']) .running {
    font-family: var(--font-num);
    font-size: 12px;
    color: var(--nav-text);
  }

  :global([data-look='tecnica']) .live,
  :global([data-look='tecnica']) .github,
  :global([data-look='tecnica']) .looks {
    padding: 0 20px;
    font-family: var(--font-num);
    font-size: 11px;
    font-stretch: normal;
  }

  :global([data-look='tecnica']) .me {
    padding: 14px 12px 0 20px;
    border-top-width: 1.5px;
  }

  /* On phones the sidebar becomes a tab bar along the bottom edge. */
  @media (max-width: 720px) {
    .sidebar {
      flex-direction: row;
      align-items: center;
      height: auto;
      gap: 4px;
      padding: 4px 8px calc(4px + env(safe-area-inset-bottom));
      border-right: 0;
    }

    .brand,
    .looks,
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
      padding: 6px 12px;
      border-left: 0;
      border-top: 3px solid transparent;
      font-size: 11px;
    }

    .nav a.on {
      border-top-color: var(--nav-text);
    }

    .badge,
    .running {
      position: absolute;
      top: 2px;
      right: 2px;
      margin: 0;
    }

    .badge {
      min-width: 16px;
      padding: 0 4px;
      font-size: 10px;
      line-height: 16px;
    }

    .running {
      font-size: 0;
    }

    .bottom {
      margin: 0;
      padding: 0;
    }

    .me {
      gap: 2px;
      margin: 0;
      padding: 0;
      border: 0;
    }
  }
</style>

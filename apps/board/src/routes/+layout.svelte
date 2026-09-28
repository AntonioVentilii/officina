<script lang="ts">
  import '../app.css';
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Toasts from '$lib/components/Toasts.svelte';
  import { board } from '$lib/state/board.svelte';
  import { live } from '$lib/state/live.svelte';
  import { session } from '$lib/state/session.svelte';
  import { toasts } from '$lib/state/toasts.svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  type Theme = 'system' | 'dark' | 'light';
  const THEME_KEY = 'officina.theme';
  const readTheme = (): Theme => {
    try {
      const value = localStorage.getItem(THEME_KEY);
      return value === 'dark' || value === 'light' ? value : 'system';
    } catch {
      return 'system';
    }
  };
  let theme = $state<Theme>(readTheme());

  $effect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // The theme then lasts for this visit only.
    }
  });

  const cycleTheme = () =>
    (theme = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system');

  const onSignIn = $derived(page.url.pathname === '/signin');

  $effect(() => {
    if (!onSignIn) void session.load();
  });

  $effect(() => {
    if (session.status === 'signed-out' && !onSignIn) void goto('/signin');
  });

  // Back from GitHub after connecting an account.
  $effect(() => {
    if (session.status !== 'ready' || page.url.searchParams.get('github') !== 'linked') return;
    const login = session.me?.github?.login;
    if (login) toasts.show('ok', `GitHub connected as @${login}`);
    void goto(page.url.pathname, { replaceState: true, noScroll: true });
  });

  $effect(() => {
    if (session.status !== 'ready' || !session.projectId) return;
    board.start(session.projectId);
    live.connect();
  });
</script>

{#if onSignIn}
  {@render children()}
{:else if session.status === 'ready'}
  <div class="shell">
    <Sidebar {theme} oncycletheme={cycleTheme} />
    <main>
      {#if session.project}
        {@render children()}
      {:else}
        <div class="state">
          <h1>No projects yet</h1>
          <p class="muted">Ask an owner to add you to a project.</p>
        </div>
      {/if}
    </main>
  </div>
{:else if session.status === 'error'}
  <div class="state">
    <h1>Officina is unreachable</h1>
    <p class="muted">{session.error}</p>
    <button class="btn" onclick={() => session.load()}>Try again</button>
  </div>
{:else}
  <div class="state"><span class="loader" aria-label="Loading"></span></div>
{/if}

<Toasts />

<style>
  .shell {
    display: grid;
    grid-template-columns: var(--sidebar) minmax(0, 1fr);
    height: 100dvh;
  }

  main {
    position: relative;
    min-width: 0;
    height: 100dvh;
    overflow: hidden;
    background: radial-gradient(1200px 380px at 30% -120px, var(--bg-glow), transparent 70%);
  }

  .state {
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 6px;
    height: 100dvh;
    text-align: center;
  }

  .state h1 {
    margin: 0;
    font-size: 18px;
  }

  .loader {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }

  @media (max-width: 720px) {
    .shell {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(0, 1fr) auto;
    }

    .shell > :global(nav) {
      order: 2;
    }

    main {
      height: auto;
    }
  }
</style>

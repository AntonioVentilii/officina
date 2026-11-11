<script lang="ts">
  import '../app.css';
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Guide from '$lib/components/Guide.svelte';
  import NewRequest from '$lib/components/NewRequest.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Toasts from '$lib/components/Toasts.svelte';
  import { board } from '$lib/state/board.svelte';
  import { guide } from '$lib/state/guide.svelte';
  import { live } from '$lib/state/live.svelte';
  import { look } from '$lib/state/look.svelte';
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

  $effect(() => {
    document.documentElement.dataset.look = look.current;
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

  // The welcome guide, the first time someone signs in here.
  $effect(() => {
    if (session.status === 'ready' && session.me) guide.showIfNew(session.me.member.id);
  });

  let draft = $state<{ title: string; request: string } | null>(null);

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

{#if session.status === 'ready' && guide.open}
  <Guide
    onclose={() => guide.close(session.me?.member.id)}
    onexample={(example) => {
      guide.close(session.me?.member.id);
      draft = example;
    }}
  />
{/if}
{#if draft}
  <NewRequest {draft} onclose={() => (draft = null)} />
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
    font-size: 32px;
    font-weight: 800;
    font-stretch: 75%;
  }

  .loader {
    width: 14px;
    height: 14px;
    background: var(--text);
    animation: signal 1s ease-in-out infinite;
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

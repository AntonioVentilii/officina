<script lang="ts">
  import { goto } from '$app/navigation';
  import { post } from '$lib/api';
  import Logo from '$lib/components/Logo.svelte';
  import { wordsFor } from '$lib/format';
  import { session } from '$lib/state/session.svelte';
  import type { GitHubSignInProblem } from '$lib/types';

  const PROBLEMS: Record<GitHubSignInProblem, string> = {
    github_mismatch: 'The GitHub sign-in did not match this browser; try again.',
    github_expired: 'The GitHub sign-in expired; try again.',
    github_not_linked:
      'This GitHub account is not linked to a member yet: sign in with an invite link, then connect GitHub.'
  };

  let status = $state<'working' | 'no-link' | 'failed'>('working');
  let message = $state('');
  let github = $state(false);

  // Only a path on this site, never an address elsewhere: resolved the way the browser would
  // (tabs and newlines dropped, `\` read as `/`), and refused when it lands on another origin.
  const raw = new URLSearchParams(location.search).get('next') ?? '';
  const resolved = raw.startsWith('/') ? URL.parse(raw, location.origin) : null;
  const next =
    resolved?.origin === location.origin
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : '/';
  const githubHref = `/auth/github/start?mode=signin${next === '/' ? '' : `&next=${encodeURIComponent(next)}`}`;

  $effect(() => {
    fetch('/auth/options')
      .then((response) => response.json() as Promise<{ github: boolean }>)
      .then((options) => (github = options.github))
      .catch(() => {});
    const error = new URLSearchParams(location.search).get('error');
    if (error) {
      status = 'failed';
      message = wordsFor(PROBLEMS, error, 'The sign-in did not complete; try again.');
    }
  });

  const redeem = () => {
    const token = location.hash.slice(1);
    // The link is spent on first use; drop it from the address bar and history straight away.
    history.replaceState(null, '', `/signin${location.search}`);
    if (!token) {
      if (status === 'working' && !new URLSearchParams(location.search).get('error'))
        status = 'no-link';
      return;
    }
    status = 'working';
    post('/auth/redeem', { token })
      .then(async () => {
        await session.load();
        await goto(next, { replaceState: true });
      })
      .catch((error: Error) => {
        status = 'failed';
        message = error.message;
      });
  };

  // A link pasted while this page is open only changes the fragment, which is not a navigation.
  $effect(() => {
    redeem();
    window.addEventListener('hashchange', redeem);
    return () => window.removeEventListener('hashchange', redeem);
  });
</script>

<div class="page">
  <div class="card">
    <Logo size={48} />
    <h1 class="page-title">Officina</h1>
    {#if status === 'working'}
      <p class="muted">Signing you in…</p>
    {:else if status === 'failed'}
      <p class="error">{message}</p>
      <p class="muted">Ask an owner for a new link.</p>
      {#if github}
        <a class="btn github" href={githubHref} data-sveltekit-reload> Sign in with GitHub </a>
      {/if}
    {:else}
      <p class="muted">Sign in with the link an owner sent you.</p>
      {#if github}
        <a class="btn github" href={githubHref} data-sveltekit-reload> Sign in with GitHub </a>
        <p class="faint small">Works once you have connected GitHub from the board.</p>
      {/if}
      <p class="faint small">
        Owners get one with <code>scripts/officina login-link</code>, and add people with
        <code>scripts/officina invite</code>.
      </p>
    {/if}
  </div>
</div>

<style>
  :global([data-look='tecnica']) .card {
    padding: 24px;
    border: 1.5px solid var(--rule);
    background: var(--panel);
  }

  .page {
    display: grid;
    place-items: center;
    min-height: 100dvh;
    padding: 24px;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    width: min(420px, 100%);
    padding: 28px 0 0;
    border-top: 6px solid var(--rule);
  }

  h1 {
    margin: 18px 0 14px;
  }

  p {
    margin: 2px 0;
  }

  .github {
    margin: 12px 0 4px;
  }

  .error {
    color: var(--danger);
    font-weight: 600;
  }

  .small {
    font-size: 12.5px;
    line-height: 1.6;
  }

  code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 1px 4px;
    background: var(--tint);
  }
</style>

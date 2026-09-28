<script lang="ts">
  import { goto } from '$app/navigation';
  import { post } from '$lib/api';
  import { session } from '$lib/state/session.svelte';

  let status = $state<'working' | 'no-link' | 'failed'>('working');
  let message = $state('');

  const redeem = () => {
    const token = location.hash.slice(1);
    // The link is spent on first use; drop it from the address bar and history straight away.
    history.replaceState(null, '', '/signin');
    if (!token) {
      if (status === 'working') status = 'no-link';
      return;
    }
    status = 'working';
    post('/auth/redeem', { token })
      .then(async () => {
        await session.load();
        await goto('/', { replaceState: true });
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
    <svg viewBox="0 0 32 32" width="40" height="40" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--panel-3)" />
      <path d="M8 13h13l3-3h2v4l-3 2H19v3l3 5H10l3-5v-3H8z" fill="var(--accent)" />
    </svg>
    <h1>Officina</h1>
    {#if status === 'working'}
      <p class="muted">Signing you in…</p>
    {:else if status === 'failed'}
      <p class="error">{message}</p>
      <p class="muted">Ask an owner for a new link.</p>
    {:else}
      <p class="muted">Sign in with the link an owner sent you.</p>
      <p class="faint small">
        Owners get one with <code>scripts/officina login-link</code>, and add people with
        <code>scripts/officina invite</code>.
      </p>
    {/if}
  </div>
</div>

<style>
  .page {
    display: grid;
    place-items: center;
    min-height: 100dvh;
    padding: 24px;
    background: radial-gradient(900px 420px at 50% -80px, var(--bg-glow), transparent 70%);
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    width: min(380px, 100%);
    padding: 32px 28px;
    border-radius: var(--radius-lg);
    background: var(--panel);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    text-align: center;
  }

  h1 {
    margin: 10px 0 2px;
    font-size: 20px;
    letter-spacing: -0.02em;
  }

  p {
    margin: 4px 0;
  }

  .error {
    color: var(--danger);
  }

  .small {
    font-size: 12px;
    line-height: 1.6;
  }

  code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--panel-3);
  }
</style>

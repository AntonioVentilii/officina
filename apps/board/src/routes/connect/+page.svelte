<script lang="ts">
  import { PlugZap } from '@lucide/svelte';
  import { get, post } from '$lib/api';
  import { wordsFor } from '$lib/format';
  import type { AuthorizationProblem } from '$lib/types';

  const PROBLEMS: Record<AuthorizationProblem, string> = {
    unknown_client: 'This connector is not registered with Officina; remove it and add it again.',
    unregistered_redirect: 'The connector asked to return to an address it did not register.'
  };

  interface Request {
    readonly client: string;
    readonly returnsTo: string;
    readonly member: string;
    readonly projects: readonly string[];
  }

  let request = $state<Request | null>(null);
  let failure = $state('');
  let busy = $state(false);

  // The app that asked (for example Claude) sent these through `/oauth/authorize`; the API checks
  // them again when the person decides.
  const params = Object.fromEntries(new URLSearchParams(location.search));

  $effect(() => {
    if (params.error) {
      failure = wordsFor(PROBLEMS, params.error, 'Officina cannot complete this connection.');
      return;
    }
    get<Request | { redirect: string }>(`/api/connector/authorization${location.search}`)
      .then((answer) => {
        if ('redirect' in answer) location.href = answer.redirect;
        else request = answer;
      })
      .catch((error: Error) => (failure = wordsFor(PROBLEMS, error.message, error.message)));
  });

  const decide = async (allow: boolean) => {
    busy = true;
    try {
      const { redirect } = await post<{ redirect: string }>('/api/connector/authorization', {
        params,
        allow
      });
      location.href = redirect;
    } catch (error) {
      const { message } = error as Error;
      failure = wordsFor(PROBLEMS, message, message);
      busy = false;
    }
  };
</script>

<div class="page">
  <header>
    <h1 class="page-title">Connect an app</h1>
  </header>
  <section>
    {#if failure}
      <p class="error">{failure}</p>
      <p class="muted">Go back to the app and add Officina again.</p>
    {:else if request}
      <div class="card">
        <PlugZap size={28} />
        <h2>{request.client} wants to use Officina as {request.member}</h2>
        <p>
          It will be able to open requests, show what is waiting on you, answer questions, comment,
          and approve or ask for changes, in {request.projects.length
            ? request.projects.join(', ')
            : 'your projects'}, with your role in each. It cannot do anything you cannot do on the
          board.
        </p>
        <p class="muted">
          After you allow it, you go back to {request.returnsTo}. To stop it, remove Officina from
          that app's connectors.
        </p>
        <div class="actions">
          <button class="btn primary" disabled={busy} onclick={() => decide(true)}>Allow</button>
          <button class="btn ghost" disabled={busy} onclick={() => decide(false)}>Refuse</button>
        </div>
      </div>
    {:else}
      <span class="loader" aria-label="Loading"></span>
    {/if}
  </section>
</div>

<style>
  .page {
    height: 100%;
    overflow-y: auto;
    padding-bottom: 48px;
  }

  header {
    margin-bottom: 28px;
    padding: 28px 32px 22px;
    border-bottom: 3px solid var(--rule);
  }

  section {
    max-width: 560px;
    margin: 0 32px;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  h2 {
    margin: 4px 0 0;
    font-size: 22px;
    font-weight: 800;
    font-stretch: 75%;
  }

  p {
    margin: 0;
    line-height: 1.55;
  }

  .actions {
    display: flex;
    gap: 10px;
    margin-top: 8px;
  }

  .error {
    color: var(--danger);
    font-weight: 600;
  }

  .loader {
    display: block;
    width: 14px;
    height: 14px;
    background: var(--text);
  }

  @media (max-width: 720px) {
    header {
      padding: 20px 16px 16px;
    }

    section {
      margin: 0 16px;
    }
  }
</style>

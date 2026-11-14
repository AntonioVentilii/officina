<script lang="ts">
  import { PlugZap } from '@lucide/svelte';
  import { get, post } from '$lib/api';
  import { ago, wordsFor } from '$lib/format';
  import { clock } from '$lib/state/clock.svelte';
  import { toasts } from '$lib/state/toasts.svelte';
  import type { AuthorizationProblem, ConnectedApp, ConnectedAppProblem } from '$lib/types';

  const PROBLEMS: Record<AuthorizationProblem, string> = {
    unknown_client: 'This connector is not registered with Officina; remove it and add it again.',
    unregistered_redirect: 'The connector asked to return to an address it did not register.',
    unsupported_response_type:
      'The connector sent a request Officina cannot accept: only the code flow is supported.',
    pkce_required:
      'The connector sent a request Officina cannot accept: PKCE with code_challenge_method S256 is required.',
    unknown_resource:
      'The connector sent a request Officina cannot accept: it asked for tokens for another server.',
    unknown_scope:
      'The connector sent a request Officina cannot accept: it asked for a scope Officina does not offer.'
  };

  const REVOKE_PROBLEMS: Record<ConnectedAppProblem, string> = {
    unknown_grant: 'That app is no longer connected.'
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
  let apps = $state<readonly ConnectedApp[] | null>(null);

  // The app that asked (for example Claude) sent these through `/oauth/authorize`; the API checks
  // them again when the person decides. Without them this page lists the apps already connected.
  const params = Object.fromEntries(new URLSearchParams(location.search));
  const asking = Boolean(params.client_id || params.error);

  const loadApps = () =>
    get<{ grants: readonly ConnectedApp[] }>('/api/connector/grants')
      .then((answer) => (apps = answer.grants))
      .catch((error: Error) => (failure = error.message));

  $effect(() => {
    if (!asking) {
      loadApps();
      return;
    }
    if (params.error) {
      failure = wordsFor(PROBLEMS, params.error, 'Officina cannot complete this connection.');
      return;
    }
    get<Request>(`/api/connector/authorization${location.search}`)
      .then((answer) => (request = answer))
      .catch((error: Error) => (failure = wordsFor(PROBLEMS, error.message, error.message)));
  });

  const revoke = async (app: ConnectedApp) => {
    try {
      await post(`/api/connector/grants/${app.id}/revoke`);
      toasts.show('ok', `${app.client} can no longer act for you.`);
    } catch (error) {
      const { message } = error as Error;
      toasts.show('error', wordsFor(REVOKE_PROBLEMS, message, message));
    }
    await loadApps();
  };

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
    <h1 class="page-title">{asking ? 'Connect an app' : 'Connected apps'}</h1>
  </header>
  <section>
    {#if failure}
      <p class="error">{failure}</p>
      {#if asking}<p class="muted">Go back to the app and add Officina again.</p>{/if}
    {:else if !asking && apps}
      {#if apps.length}
        <ul class="apps">
          {#each apps as app (app.id)}
            <li>
              <div>
                <strong>{app.returnsTo.join(', ')}</strong>
                <span class="muted">calls itself “{app.client}”</span>
                <div class="faint small">Last renewed {ago(app.renewedAt, clock.now)}</div>
              </div>
              <button class="btn ghost" onclick={() => revoke(app)}>Revoke</button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">No app can act for you. Add Officina to Claude to connect one.</p>
      {/if}
    {:else if request}
      <div class="card">
        <PlugZap size={28} />
        <h2>An app at {request.returnsTo} wants to use Officina as {request.member}</h2>
        <p class="muted">
          It calls itself “{request.client}”. Apps name themselves when they register, so Officina
          has not verified that name: allow it only if you are adding Officina to an app you trust
          at {request.returnsTo} right now.
        </p>
        <p>
          It will be able to open requests, show what is waiting on you, answer questions, comment,
          and approve or ask for changes, in {request.projects.length
            ? request.projects.join(', ')
            : 'your projects'}, with your role in each. It cannot do anything you cannot do on the
          board.
        </p>
        <p class="muted">
          After you allow it, you go back to {request.returnsTo}. It keeps access until you revoke
          it under Connected apps on the board; removing Officina from the app alone does not end
          it.
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

  .apps {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .apps li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }

  .small {
    font-size: 12.5px;
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

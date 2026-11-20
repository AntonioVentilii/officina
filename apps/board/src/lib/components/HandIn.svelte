<script lang="ts">
  import { post } from '#lib/api.ts';
  import { session } from '#lib/state/session.svelte.ts';

  interface Props {
    number: number;
    branch: string;
    /** Sends the hand-in as an action on the task, shown at work until the task reloads. */
    send: (request: () => Promise<string>) => Promise<boolean>;
  }

  let { number, branch, send }: Props = $props();

  let open = $state(false);
  let title = $state('');
  let body = $state('');
  let checked = $state('');

  const limits = $derived(session.me?.limits.prTitle);
  const ready = $derived(limits !== undefined && title.trim().length >= limits.min);

  const lines = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

  const handIn = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!session.projectId || !ready) return;
    // What was written stays when the hand-in fails, to send again once fixed.
    const taken = await send(async () => {
      await post(`/api/projects/${session.projectId}/tasks/${number}/hand-in`, {
        prTitle: title.trim(),
        ...(body.trim() ? { prBody: body.trim() } : {}),
        verified: lines(checked)
      });
      return 'Handed in; the reviewers read it next';
    });
    if (taken) open = false;
  };
</script>

{#if open}
  <form class="hand-in" onsubmit={handIn}>
    <p class="faint">
      Push the task branch <code>{branch}</code> first, built by hand or with your own agents. Officina
      reads the push from GitHub and opens the pull request.
    </p>
    <label class="caps" for="hand-in-title-{number}">Pull request title</label>
    <input
      id="hand-in-title-{number}"
      class="field"
      bind:value={title}
      placeholder="feat(scope): what it does"
      maxlength={limits?.max}
    />
    <label class="caps" for="hand-in-body-{number}">Pull request body (with a template)</label>
    <textarea
      id="hand-in-body-{number}"
      class="field"
      bind:value={body}
      rows="6"
      maxlength={session.me?.limits.prBody}
      placeholder="Only when the project has a pull request template, and then required: write it in the template, keeping every heading"
    ></textarea>
    <label class="caps" for="hand-in-checked-{number}">What you checked (optional)</label>
    <textarea
      id="hand-in-checked-{number}"
      class="field"
      bind:value={checked}
      rows="3"
      placeholder="One item per line"></textarea>
    <div class="buttons">
      <button type="button" class="btn ghost" onclick={() => (open = false)}>Back</button>
      <button class="btn primary" disabled={!ready}>Hand in</button>
    </div>
  </form>
{:else}
  <button class="btn primary" onclick={() => (open = true)}>Hand in the build</button>
{/if}

<style>
  .hand-in {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  p {
    margin: 0;
    font-size: 13px;
  }
</style>

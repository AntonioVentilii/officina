<script lang="ts">
  import { Bug, Copy, Lightbulb, PenLine } from '@lucide/svelte';
  import { session } from '$lib/state/session.svelte';
  import { toasts } from '$lib/state/toasts.svelte';
  import Modal from './Modal.svelte';

  interface Draft {
    readonly title: string;
    readonly request: string;
  }

  interface Props {
    onclose: () => void;
    /** Opens a new request filled in with an example, for the person to complete. */
    onexample: (draft: Draft) => void;
  }

  let { onclose, onexample }: Props = $props();

  const EXAMPLES = [
    {
      id: 'text',
      label: 'Change a text',
      icon: PenLine,
      draft: {
        title: 'Change the text of …',
        request:
          'Where: [the screen, page or email]\nIt says now: "[the current text]"\nIt should say: "[the new text]", in every language.\nNothing else on that screen changes.'
      }
    },
    {
      id: 'bug',
      label: 'Report a bug',
      icon: Bug,
      draft: {
        title: '… does not work',
        request:
          'What I did: [the steps, one per line]\nWhat I expected: …\nWhat happened instead: …\nWhere: [screen, browser or phone]'
      }
    },
    {
      id: 'feature',
      label: 'Ask for a feature',
      icon: Lightbulb,
      draft: {
        title: 'Let people …',
        request:
          'Who needs it: …\nWhat they should be able to do: …\nWhy it matters: …\nWhat must stay as it is: …'
      }
    }
  ] as const;

  const project = $derived(session.project);
  const canRequest = $derived(project !== null && project.role !== 'watcher');
  const connectorUrl = `${location.origin}/mcp`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(connectorUrl);
      toasts.show('ok', 'Address copied');
    } catch {
      toasts.show('error', 'Copy it by hand: the browser refused');
    }
  };
</script>

<Modal title="Welcome to Officina" {onclose}>
  <div class="guide">
    <p class="lead">
      Say what you need in plain words. Agents ask a few questions, write a plan, build it and
      review it. People decide: you approve the plan, check the result, and a person merges it.
    </p>

    <section>
      <h3><span class="step num">1</span>Make a request</h3>
      <p>
        Press <strong>New request</strong> on the board. Say what should be different, where, why, and
        what must stay as it is. An agent may ask you a few questions first.
      </p>
      <div class="examples">
        {#each EXAMPLES as example (example.id)}
          <button class="btn" disabled={!canRequest} onclick={() => onexample(example.draft)}>
            <example.icon size={15} />{example.label}
          </button>
        {/each}
      </div>
      {#if !project}
        <p class="faint">Ask an owner to add you to a project first.</p>
      {:else if !canRequest}
        <p class="faint">You can read this project; ask an owner to let you open requests.</p>
      {/if}
    </section>

    <section>
      <h3><span class="step num">2</span>Yellow means it is your turn</h3>
      <div class="sample">Your turn: an agent asked you a question</div>
      <p>
        When a task waits on you (a question to answer, a plan to approve, a result to check), its
        page shows this yellow block with the button to press. Yellow means only that. The
        <strong>Inbox</strong> lists everything waiting on you.
      </p>
    </section>

    <section>
      <h3><span class="step num">3</span>Use Officina from Claude</h3>
      <p>Add Officina to Claude once, then make requests and answer questions from a chat.</p>
      <ol>
        <li>
          In claude.ai open <strong>Settings &gt; Connectors &gt; Add custom connector</strong>.
        </li>
        <li>
          Name it Officina and paste this address:
          <span class="address">
            <code>{connectorUrl}</code>
            <button class="btn ghost icon sm" onclick={copy} aria-label="Copy the address"
              ><Copy size={13} /></button
            >
          </span>
        </li>
        <li>
          Press <strong>Connect</strong>, then <strong>Allow</strong> on the page Officina opens.
        </li>
      </ol>
      <p class="faint">
        The Claude desktop app uses the same account. In Claude Code:
        <code>claude mcp add --transport http officina {connectorUrl}</code>. Then ask "What is
        waiting on me in Officina?"
      </p>
    </section>
  </div>
  {#snippet footer()}
    <span class="faint small">Open it again from Guide in the sidebar.</span>
    <button class="btn primary" onclick={onclose}>Got it</button>
  {/snippet}
</Modal>

<style>
  .guide {
    display: flex;
    flex-direction: column;
    gap: 22px;
  }

  p {
    margin: 0;
    line-height: 1.55;
  }

  .lead {
    font-size: 15px;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  h3 {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    font-size: 18px;
    font-weight: 800;
    font-stretch: 75%;
  }

  .step {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    background: var(--text);
    color: var(--bg);
    font-size: 12px;
  }

  .examples {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  /* The same yellow as the real block, so people recognise it on a task. */
  .sample {
    padding: 12px 16px;
    background: var(--accent);
    color: var(--accent-text);
    font-weight: 700;
  }

  ol {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding-left: 20px;
    line-height: 1.55;
  }

  .address {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  code {
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 1px 4px;
    background: var(--tint);
    overflow-wrap: anywhere;
  }

  .small {
    align-self: center;
    margin-right: auto;
    font-size: 12.5px;
  }
</style>

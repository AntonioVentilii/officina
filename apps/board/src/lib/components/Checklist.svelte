<script lang="ts">
  import { post } from '#lib/api.ts';
  import { ago } from '#lib/format.ts';
  import { toasts } from '#lib/state/toasts.svelte.ts';
  import { latestChecks, type ChecklistView } from '#lib/checklist.ts';
  import type { BeforeAfter } from '#lib/types.ts';

  interface Props {
    view: ChecklistView;
    beforeAfter: readonly BeforeAfter[];
    /** Where a check is sent: the task's checks route. */
    path: string;
    onchanged: () => void;
  }

  let { view, beforeAfter, path, onchanged }: Props = $props();

  const latest = $derived(latestChecks(view));
  const ok = $derived(latest.filter((check) => check?.outcome === 'ok').length);

  let open = $state<number | null>(null);
  let outcome = $state('ok');
  let evidence = $state('');
  let busy = $state(false);

  const start = (index: number) => {
    open = open === index ? null : index;
    outcome = latest[index]?.outcome ?? 'ok';
    evidence = '';
  };

  const record = async (event: SubmitEvent, index: number) => {
    event.preventDefault();
    busy = true;
    try {
      await post(path, { item: index + 1, outcome, evidence: evidence.trim() });
      open = null;
      onchanged();
    } catch (error) {
      toasts.show('error', (error as Error).message);
    } finally {
      busy = false;
    }
  };

  const locales = $derived([...new Set(beforeAfter.map((row) => row.locale))]);
  let locale = $state<string | null>(null);
  const shownLocale = $derived(locale ?? locales[0] ?? null);
  const rows = $derived(beforeAfter.filter((row) => row.locale === shownLocale));
</script>

<div class="checklist">
  <div class="progress">
    <span class="bar"><span style:width="{(ok / view.checklist.length) * 100}%"></span></span>
    <span class="faint num">{ok}/{view.checklist.length} ok</span>
  </div>
  <ul>
    {#each view.checklist as item, index (index)}
      {@const check = latest[index]}
      <li class={check?.outcome ?? 'unchecked'}>
        <div class="item">
          <span class="num">{index + 1}.</span>
          <span class="text">{item}</span>
          {#if view.canCheck}
            <button class="link-button link" onclick={() => start(index)}
              >{check ? 'Check again' : 'Check'}</button
            >
          {/if}
        </div>
        <p class="state faint">
          {#if check}
            <strong>{check.outcomeLabel}</strong>, {check.by}, {ago(check.at)}{#if check.evidence}: {check.evidence}{/if}
          {:else}
            Not checked
          {/if}
        </p>
        {#if open === index}
          <form onsubmit={(event) => record(event, index)}>
            <div class="outcomes">
              {#each view.outcomes as choice (choice.value)}
                <label>
                  <input type="radio" bind:group={outcome} value={choice.value} />
                  {choice.label}
                </label>
              {/each}
            </div>
            <input
              class="field"
              bind:value={evidence}
              maxlength="300"
              required
              placeholder="How you checked it, and what is still open"
            />
            <div class="buttons">
              <button type="button" class="btn ghost" onclick={() => (open = null)}>Back</button>
              <button class="btn primary" disabled={busy || !evidence.trim()}>Record</button>
            </div>
          </form>
        {/if}
      </li>
    {/each}
  </ul>
</div>

{#if beforeAfter.length}
  <div class="compare">
    <div class="compare-head">
      <h4 class="caps">Before and after</h4>
      {#if locales.length > 1}
        <div class="locales">
          {#each locales as code (code)}
            <button class:on={code === shownLocale} onclick={() => (locale = code)}>{code}</button>
          {/each}
        </div>
      {/if}
    </div>
    <table>
      <thead class="caps"><tr><th>Key</th><th>Before</th><th>After</th></tr></thead>
      <tbody>
        <!-- The agent can list the same key twice in a locale. -->
        {#each rows as row, index (index)}
          <tr>
            <td class="key mono">{row.key}</td>
            <td class="before">{row.before}</td>
            <td class="after">{row.after}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .progress {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 6px;
    font-size: 12px;
  }

  .bar {
    flex: 1;
    height: 3px;
    background: var(--border);
  }

  .bar span {
    display: block;
    height: 100%;
    background: var(--rule);
    transition: width 0.3s var(--ease);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
  }

  li + li {
    border-top: 1px solid var(--border);
  }

  li {
    padding: 10px 4px;
    font-size: 14px;
    line-height: 1.5;
  }

  .item {
    display: flex;
    gap: 10px;
    align-items: baseline;
  }

  .item .text {
    flex: 1;
  }

  .state {
    margin: 2px 0 0 22px;
    font-size: 12px;
  }

  .problem .state strong {
    color: var(--danger);
  }

  .ok .item .text {
    color: var(--text-3);
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 8px 0 0 22px;
  }

  .outcomes {
    display: flex;
    gap: 16px;
    font-size: 13px;
  }

  .outcomes label {
    display: flex;
    gap: 6px;
    align-items: center;
    cursor: pointer;
  }

  .buttons {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .link {
    flex: none;
    font-size: 12.5px;
    color: var(--text-2);
  }

  .compare {
    margin-top: 22px;
  }

  .compare-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 6px;
  }

  h4 {
    margin: 0;
    font-weight: 700;
  }

  .locales {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }

  .locales button {
    padding: 2px 0 3px;
    border: 0;
    border-bottom: 3px solid transparent;
    background: none;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .locales button.on {
    color: var(--text);
    border-bottom-color: var(--rule);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  th,
  td {
    padding: 8px 10px 8px 0;
    border-bottom: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
  }

  th {
    font-weight: 700;
    color: var(--text-2);
    border-bottom-color: var(--rule);
  }

  .key {
    font-size: 11px;
    color: var(--text-3);
    word-break: break-all;
    width: 34%;
  }

  .before {
    color: var(--text-3);
    text-decoration: line-through;
  }

  .after {
    color: var(--text);
    font-weight: 600;
  }
</style>

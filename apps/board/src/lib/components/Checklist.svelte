<script lang="ts">
  import type { BeforeAfter } from '$lib/types';

  interface Props {
    items: readonly string[];
    beforeAfter: readonly BeforeAfter[];
    /** Ticks are a personal aid, kept in this browser per task and commit. */
    storageKey: string;
  }

  let { items, beforeAfter, storageKey }: Props = $props();

  const read = (): number[] => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '[]') as number[];
    } catch {
      return [];
    }
  };

  let checked = $state<number[]>(read());

  const toggle = (index: number) => {
    checked = checked.includes(index)
      ? checked.filter((item) => item !== index)
      : [...checked, index];
    try {
      localStorage.setItem(storageKey, JSON.stringify(checked));
    } catch {
      // Ticks then last for this visit only.
    }
  };

  const locales = $derived([...new Set(beforeAfter.map((row) => row.locale))]);
  let locale = $state<string | null>(null);
  const shownLocale = $derived(locale ?? locales[0] ?? null);
  const rows = $derived(beforeAfter.filter((row) => row.locale === shownLocale));
</script>

<div class="checklist">
  <div class="progress">
    <span class="bar"><span style:width="{(checked.length / items.length) * 100}%"></span></span>
    <span class="faint num">{checked.length}/{items.length}</span>
  </div>
  <ul>
    {#each items as item, index (index)}
      <li class:done={checked.includes(index)}>
        <label>
          <input type="checkbox" checked={checked.includes(index)} onchange={() => toggle(index)} />
          <span>{item}</span>
        </label>
      </li>
    {/each}
  </ul>
</div>

{#if beforeAfter.length}
  <div class="compare">
    <div class="compare-head">
      <h4>Before and after</h4>
      {#if locales.length > 1}
        <div class="locales">
          {#each locales as code (code)}
            <button class:on={code === shownLocale} onclick={() => (locale = code)}>{code}</button>
          {/each}
        </div>
      {/if}
    </div>
    <table>
      <thead><tr><th>Key</th><th>Before</th><th>After</th></tr></thead>
      <tbody>
        {#each rows as row (row.key + row.locale)}
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
    gap: 10px;
    margin-bottom: 8px;
    font-size: 12px;
  }

  .bar {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: var(--panel-3);
    overflow: hidden;
  }

  .bar span {
    display: block;
    height: 100%;
    background: var(--ok);
    transition: width 0.3s var(--ease);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  label {
    display: flex;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 13px;
    line-height: 1.55;
  }

  label:hover {
    background: var(--hover);
  }

  input {
    flex: none;
    width: 15px;
    height: 15px;
    margin-top: 3px;
    accent-color: var(--ok);
  }

  .done span {
    color: var(--text-3);
    text-decoration: line-through;
    text-decoration-color: var(--border-strong);
  }

  .compare {
    margin-top: 18px;
  }

  .compare-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
  }

  h4 {
    margin: 0;
    font-size: 12.5px;
    font-weight: 650;
  }

  .locales {
    display: flex;
    gap: 2px;
    flex-wrap: wrap;
  }

  .locales button {
    height: 24px;
    padding: 0 8px;
    border-radius: 5px;
    border: 1px solid transparent;
    background: none;
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .locales button.on {
    border-color: var(--border-strong);
    background: var(--panel-3);
    color: var(--text);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }

  th,
  td {
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
  }

  th {
    font-size: 11px;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-3);
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
    text-decoration-color: color-mix(in srgb, var(--danger) 60%, transparent);
  }

  .after {
    color: var(--text);
    font-weight: 550;
    background: color-mix(in srgb, var(--ok) 7%, transparent);
  }
</style>

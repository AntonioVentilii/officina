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

  label {
    display: flex;
    gap: 12px;
    padding: 10px 4px;
    cursor: pointer;
    font-size: 14px;
    line-height: 1.5;
  }

  label:hover {
    background: var(--hover);
  }

  input {
    flex: none;
    width: 16px;
    height: 16px;
    margin-top: 2px;
    accent-color: var(--text);
  }

  .done span {
    color: var(--text-3);
    text-decoration: line-through;
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

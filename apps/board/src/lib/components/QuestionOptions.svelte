<script lang="ts">
  import type { QuestionOption } from '$lib/types';
  import OptionPreview from './OptionPreview.svelte';

  interface Props {
    options: readonly QuestionOption[];
    /** Without it the options are shown to read only: the viewer cannot answer. */
    onchoose?: ((key: string) => void) | undefined;
    busy: boolean;
  }

  let { options, onchoose, busy }: Props = $props();
</script>

<ol class="options">
  {#each options as option (option.key)}
    <li class="option">
      <div class="title">
        <span class="key mono">{option.key}</span>
        <div class="grow">
          <div class="label">{option.label}</div>
          {#if option.detail}<div class="detail">{option.detail}</div>{/if}
        </div>
        {#if onchoose}
          <button
            class="btn"
            disabled={busy}
            aria-label="Choose option {option.key}: {option.label}"
            onclick={() => onchoose(option.key)}>Choose</button
          >
        {/if}
      </div>
      {#if option.preview}
        <OptionPreview preview={option.preview} label="Preview of option {option.key}" />
      {/if}
    </li>
  {/each}
</ol>

<style>
  .options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .option {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .title {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .key {
    flex: none;
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border: 1.5px solid currentColor;
    font-size: 12px;
    font-weight: 700;
  }

  .grow {
    flex: 1;
    min-width: 0;
  }

  .label {
    font-weight: 700;
    font-size: 14px;
  }

  .detail {
    font-size: 13px;
    opacity: 0.8;
  }
</style>

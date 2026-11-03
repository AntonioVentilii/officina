<script lang="ts">
  import { initials } from '$lib/format';

  interface Props {
    name: string;
    size?: number;
  }

  let { name, size = 22 }: Props = $props();
</script>

<span class="avatar" style:--size="{size}px" title={name}>{initials(name)}</span>

<style>
  /* People are letters on a grey field; agents are black shapes. The two never look alike. */
  .avatar {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: var(--size);
    height: var(--size);
    font-size: calc(var(--size) * 0.46);
    font-weight: 800;
    font-stretch: 85%;
    letter-spacing: 0.02em;
    line-height: 1;
    color: var(--text);
    background: var(--tint);
  }
</style>

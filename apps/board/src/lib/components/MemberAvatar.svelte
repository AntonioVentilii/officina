<script lang="ts">
  import { initials } from '$lib/format';

  interface Props {
    name: string;
    size?: number;
  }

  let { name, size = 22 }: Props = $props();

  // A stable hue per name, so the same person always looks the same.
  const hue = $derived([...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7));
</script>

<span class="avatar" style:--h={hue} style:--size="{size}px" title={name}>{initials(name)}</span>

<style>
  .avatar {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: var(--size);
    height: var(--size);
    border-radius: 50%;
    font-size: calc(var(--size) * 0.42);
    font-weight: 650;
    letter-spacing: 0.02em;
    color: hsl(var(--h) 70% 72%);
    background: hsl(var(--h) 45% 30% / 0.35);
    box-shadow: inset 0 0 0 1px hsl(var(--h) 50% 60% / 0.25);
  }

  :global([data-theme='light']) .avatar {
    color: hsl(var(--h) 55% 35%);
    background: hsl(var(--h) 60% 88%);
  }
</style>

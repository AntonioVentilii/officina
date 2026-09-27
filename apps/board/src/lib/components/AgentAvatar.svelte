<script lang="ts">
  import { roleColor, roleIcon } from './roles';

  interface Props {
    role: string;
    label?: string;
    running?: boolean;
    size?: number;
  }

  let { role, label, running = false, size = 24 }: Props = $props();

  const Icon = $derived(roleIcon(role));
</script>

<span
  class="avatar"
  class:running
  style:--hue={roleColor(role)}
  style:--size="{size}px"
  title={label}
  aria-label={label}
  role="img"
>
  <Icon size={Math.round(size * 0.55)} strokeWidth={2.2} />
</span>

<style>
  .avatar {
    position: relative;
    display: inline-grid;
    place-items: center;
    flex: none;
    width: var(--size);
    height: var(--size);
    border-radius: 50%;
    color: var(--hue);
    background: color-mix(in srgb, var(--hue) 16%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 30%, transparent);
  }

  .running::before {
    content: '';
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    background: conic-gradient(from 0deg, transparent 0 55%, var(--hue) 100%);
    -webkit-mask: radial-gradient(
      farthest-side,
      transparent calc(100% - 2px),
      #000 calc(100% - 2px)
    );
    mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
    animation: spin 1.1s linear infinite;
  }
</style>

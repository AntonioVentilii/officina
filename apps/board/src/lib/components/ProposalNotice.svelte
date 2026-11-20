<script lang="ts">
  import type { TaskDetail } from '#lib/types.ts';

  interface Props {
    proposal: NonNullable<TaskDetail['proposal']>;
    /** The name of the button that confirms it. */
    approve: string;
    /** Discards it, as an action on the task the panel shows at work. */
    ondiscard: () => void;
  }

  let { proposal, approve, ondiscard }: Props = $props();
</script>

<p class="proposal">
  <span>
    Claude proposed approving this for you, through the app named "{proposal.via.client}" (its own
    name, not verified), connection {proposal.via.connection} under Connected apps. It counts only once
    you press {approve}.
  </span>
  <button class="btn" onclick={ondiscard}>Discard</button>
</p>

<style>
  .proposal {
    display: flex;
    flex-basis: 100%;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin: 0;
    padding: 8px 12px;
    border-left: 3px solid currentColor;
    font-size: 13px;
  }

  /* Inside the yellow block the panel's ink, not the page's: its own button styles stop at it. */
  .proposal .btn {
    border-color: currentColor;
    color: inherit;
  }
</style>

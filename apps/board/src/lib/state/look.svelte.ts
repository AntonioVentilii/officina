import { flushSync } from 'svelte';
import type { Look } from '$lib/types';
import { session } from './session.svelte';

/** Read before first paint by the script in app.html too, so keep the key in step with it. */
export const LOOK_KEY = 'officina.look';

export const LOOKS: readonly { readonly id: Look; readonly label: string }[] = [
  { id: 'modernista', label: 'Modernista' },
  { id: 'tecnica', label: 'Tecnica' }
];

const isLook = (value: unknown): value is Look => value === 'modernista' || value === 'tecnica';

const read = (): Look | null => {
  try {
    const value = localStorage.getItem(LOOK_KEY);
    return isLook(value) ? value : null;
  } catch {
    return null;
  }
};

/** The member's own pick wins; until they make one, the project's default from its config. */
class LookState {
  chosen = $state<Look | null>(read());

  current = $derived<Look>(
    this.chosen ?? (isLook(session.project?.look) ? session.project.look : 'modernista')
  );

  /** True while the page animates from one look to the other; picks wait until it is done. */
  switching = $state(false);

  /** `from` is where the pick happened: the new look grows out of it in a circle. */
  choose(look: Look, from?: { x: number; y: number }) {
    if (this.switching || look === this.current) return;
    const apply = () => {
      // The view transition snapshots the page right after this returns, so every component and
      // the layout's data-look effect must already show the new look.
      flushSync(() => (this.chosen = look));
      try {
        localStorage.setItem(LOOK_KEY, look);
      } catch {
        // The look then lasts for this visit only.
      }
    };
    const root = document.documentElement;
    if (
      typeof document.startViewTransition !== 'function' ||
      matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      apply();
      return;
    }
    this.switching = true;
    root.dataset.lookSwitching = '';
    const x = from?.x ?? innerWidth / 2;
    const y = from?.y ?? innerHeight / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const transition = document.startViewTransition(apply);
    transition.ready
      .then(() =>
        root.animate(
          { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          {
            duration: 700,
            easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
            pseudoElement: '::view-transition-new(root)'
          }
        )
      )
      .catch(() => {});
    transition.finished
      .finally(() => {
        delete root.dataset.lookSwitching;
        this.switching = false;
      })
      .catch(() => {});
  }
}

export const look = new LookState();

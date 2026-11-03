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

  choose(look: Look) {
    this.chosen = look;
    try {
      localStorage.setItem(LOOK_KEY, look);
    } catch {
      // The look then lasts for this visit only.
    }
  }
}

export const look = new LookState();

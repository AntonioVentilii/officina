import { backOut, cubicOut } from 'svelte/easing';
import { crossfade, type TransitionConfig } from 'svelte/transition';
import { look } from './state/look.svelte';

/**
 * How cards move on the board. Only Fucina moves them; the other looks change in place, so every
 * duration is 0 there. The global reduced-motion rule in app.css shortens these too, since Svelte
 * runs them as CSS animations.
 */
const moves = () => look.current === 'fucina';

// The board's first load fills every column at once: those cards appear, they do not arrive.
let settled = false;

/** Called once the board has drawn its first load; from then on a card that appears drops in. */
export const settle = () => {
  settled = true;
};

/** A card that changes column flies there; one that comes or goes on its own drops in or lifts out. */
const [send, receive] = crossfade({
  duration: () => (moves() ? 600 : 0),
  easing: cubicOut,
  fallback: (): TransitionConfig => ({
    duration: moves() && settled ? 450 : 0,
    easing: backOut,
    css: (t) => `transform: translateY(${(1 - t) * -24}px); opacity: ${t}`
  })
});

export { receive, send };

/** The cards that stay in a column make room for the one that comes, or close the gap it leaves. */
export const flipMs = () => (moves() ? 450 : 0);

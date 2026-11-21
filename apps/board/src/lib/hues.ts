/**
 * Fucina's palette, the one place its hues are written. Each board column takes one (stages.ts) and
 * the agent that works there the same (roles.ts), so a colour says where the work is. Yellow and red
 * are not here: they keep their one meaning on every look, waiting on you and a failure (app.css).
 */
export const HUES = {
  blue: '#4d8dff',
  violet: '#9b6bff',
  orange: '#ff5a1f',
  teal: '#14b8a0',
  green: '#2fbf5b',
  pink: '#ff4fa3',
  amber: '#ffa31a',
  cyan: '#22b8e6'
} as const;

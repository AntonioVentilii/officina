import { HUES } from '#lib/hues.ts';

/**
 * Each agent role is one mark everywhere it shows: avatar, log rail and running indicator. In
 * Modernista it is a black silhouette, in Tecnica a three-letter code as on a drawing's legend, in
 * Fucina a small drawing of what the role does, animated while it runs, on a tile of its hue. Each
 * survives greyscale, small sizes and colour blindness: in Fucina the drawing tells roles apart and
 * the hue only adds to it. A role's hue is that of the column it works in (stages.ts).
 */
const ROLE_MARKS = {
  interviewer: { shape: 'circle', code: 'INT', hue: HUES.blue },
  spec: { shape: 'square', code: 'SPC', hue: HUES.violet },
  builder: { shape: 'triangle', code: 'BLD', hue: HUES.orange },
  reviewer_spec: { shape: 'half', code: 'RVS', hue: HUES.teal },
  reviewer_correctness: { shape: 'quarter', code: 'RVC', hue: HUES.green },
  chooser: { shape: 'diamond', code: 'CHS', hue: HUES.pink },
  learner: { shape: 'ring', code: 'LRN', hue: HUES.amber },
  onboarder: { shape: 'frame', code: 'ONB', hue: HUES.cyan }
} as const;

type RoleMark = (typeof ROLE_MARKS)[keyof typeof ROLE_MARKS];

export type RoleShape = RoleMark['shape'] | 'unknown';

const markOf = (role: string): RoleMark | undefined => ROLE_MARKS[role as keyof typeof ROLE_MARKS];

export const roleShape = (role: string): RoleShape => markOf(role)?.shape ?? 'unknown';

/** A role this board does not know yet has no hue, and draws in the text colour. */
export const roleHue = (role: string): string | undefined => markOf(role)?.hue;

export const roleCode = (role: string): string =>
  markOf(role)?.code ?? (role.slice(0, 3).toUpperCase() || '???');

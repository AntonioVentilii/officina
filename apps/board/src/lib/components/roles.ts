/**
 * Each agent role is one mark everywhere it shows: avatar, log rail and running indicator. In
 * Modernista it is a black silhouette, in Tecnica a three-letter code as on a drawing's legend.
 * Both survive greyscale, small sizes and colour blindness, where hues did not.
 */
const ROLE_MARKS = {
  interviewer: { shape: 'circle', code: 'INT' },
  spec: { shape: 'square', code: 'SPC' },
  builder: { shape: 'triangle', code: 'BLD' },
  reviewer_spec: { shape: 'half', code: 'RVS' },
  reviewer_correctness: { shape: 'quarter', code: 'RVC' },
  chooser: { shape: 'diamond', code: 'CHS' },
  learner: { shape: 'ring', code: 'LRN' },
  onboarder: { shape: 'frame', code: 'ONB' }
} as const;

type RoleMark = (typeof ROLE_MARKS)[keyof typeof ROLE_MARKS];

export type RoleShape = RoleMark['shape'] | 'unknown';

const markOf = (role: string): RoleMark | undefined => ROLE_MARKS[role as keyof typeof ROLE_MARKS];

export const roleShape = (role: string): RoleShape => markOf(role)?.shape ?? 'unknown';

export const roleCode = (role: string): string =>
  markOf(role)?.code ?? (role.slice(0, 3).toUpperCase() || '???');

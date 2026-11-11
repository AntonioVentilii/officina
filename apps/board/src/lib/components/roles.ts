/**
 * Each agent role is one mark everywhere it shows: avatar, log rail and running indicator. In
 * Modernista it is a black silhouette, in Tecnica a three-letter code as on a drawing's legend.
 * Both survive greyscale, small sizes and colour blindness, where hues did not.
 */
export const ROLE_SHAPES = {
  interviewer: 'circle',
  spec: 'square',
  builder: 'triangle',
  reviewer_spec: 'half',
  reviewer_correctness: 'quarter',
  chooser: 'diamond',
  learner: 'ring',
  onboarder: 'frame'
} as const;

export type RoleShape = (typeof ROLE_SHAPES)[keyof typeof ROLE_SHAPES] | 'unknown';

export const roleShape = (role: string): RoleShape =>
  ROLE_SHAPES[role as keyof typeof ROLE_SHAPES] ?? 'unknown';

const ROLE_CODES: Record<string, string> = {
  interviewer: 'INT',
  spec: 'SPC',
  builder: 'BLD',
  reviewer_spec: 'RVS',
  reviewer_correctness: 'RVC',
  chooser: 'CHS',
  learner: 'LRN',
  onboarder: 'ONB'
};

export const roleCode = (role: string): string =>
  ROLE_CODES[role] ?? (role.slice(0, 3).toUpperCase() || '???');

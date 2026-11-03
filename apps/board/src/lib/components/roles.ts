/**
 * Each agent role is one black silhouette everywhere it shows: avatar, log rail and running
 * indicator. Shapes survive greyscale, small sizes and colour blindness, where hues did not.
 */
export const ROLE_SHAPES = {
  interviewer: 'circle',
  spec: 'square',
  builder: 'triangle',
  reviewer_spec: 'half',
  reviewer_correctness: 'quarter',
  chooser: 'diamond',
  learner: 'ring'
} as const;

export type RoleShape = (typeof ROLE_SHAPES)[keyof typeof ROLE_SHAPES] | 'unknown';

export const roleShape = (role: string): RoleShape =>
  ROLE_SHAPES[role as keyof typeof ROLE_SHAPES] ?? 'unknown';

import type { Run } from '#lib/types.ts';

/** A run an agent still holds: running. */
export const isActive = (run: Pick<Run, 'status'>): boolean => run.status === 'running';

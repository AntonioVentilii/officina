import type { Run } from '$lib/types';

/** A run an agent still holds: running. */
export const isActive = (run: Pick<Run, 'status'>): boolean => run.status === 'running';

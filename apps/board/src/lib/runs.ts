import type { Run } from '$lib/types';

/** A run an agent still holds or is about to: queued or running. */
export const isActive = (run: Pick<Run, 'status'>): boolean =>
  run.status === 'running' || run.status === 'queued';

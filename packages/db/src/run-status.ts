/**
 * A run an agent still holds: the status a run leaves only when it ends. Written once here, as a
 * test on a run's status and as a SQL fragment for `status ${RUN_IS_ACTIVE}`, in a module of its
 * own so any db module can use it without importing another.
 */
const ACTIVE_STATUS = 'running';

/** Whether a run read from the database is still held by its agent. */
export const stillRunning = (run: { readonly status: string }): boolean =>
  run.status === ACTIVE_STATUS;

export const RUN_IS_ACTIVE = `= '${ACTIVE_STATUS}'`;

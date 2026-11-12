/**
 * A run an agent still holds or is about to: the statuses a run leaves only when it ends. A SQL
 * fragment for `status ${RUN_IS_ACTIVE}`, in a module of its own so any db module can use it
 * without importing another.
 */
export const RUN_IS_ACTIVE = "in ('queued', 'running')";

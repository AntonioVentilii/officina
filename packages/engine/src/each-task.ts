/** A task that failed its share of a scheduler pass, for the log; the next pass tries it again. */
export interface TaskFailure {
  readonly taskId: string;
  readonly error: string;
}

/**
 * Runs one task's share of a scheduler pass for each task in turn, each on its own: one that throws
 * is returned with its error and the tasks after it still run, so a single broken task never holds
 * up the rest of its project on every pass.
 */
export const eachTaskOnItsOwn = async (
  taskIds: readonly string[],
  work: (taskId: string) => Promise<unknown>
): Promise<TaskFailure[]> => {
  const failures: TaskFailure[] = [];
  for (const taskId of taskIds) {
    await work(taskId).catch((error: unknown) =>
      failures.push({ taskId, error: (error as Error).message })
    );
  }
  return failures;
};

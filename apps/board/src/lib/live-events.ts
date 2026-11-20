/**
 * What the server's change stream says changed. A `run` event is a new line in a run's log, sent
 * for every line; a change to the run itself (started, finished, its cost) comes as a `task` event.
 */
export type LiveEvent =
  | { readonly kind: 'task'; readonly projectId: string; readonly number: number }
  | {
      readonly kind: 'run';
      readonly projectId: string;
      readonly number: number;
      readonly runId: string;
    }
  /** Something about the project's members changed, such as a name, which any view may show. */
  | { readonly kind: 'members'; readonly projectId: string };

/** The project id of the event sent after a reconnect, which every view and run log refreshes on. */
export const EVERY_PROJECT = '*';

/** Whether the event asks every view to refresh, whatever it shows: the stream reconnected. */
export const refreshesAll = (event: LiveEvent) => event.projectId === EVERY_PROJECT;

/** Whether the event asks every view of one project to refresh: a member's name, say, changed. */
export const refreshesProject = (event: LiveEvent, projectId: string | null) =>
  refreshesAll(event) || (event.kind === 'members' && event.projectId === projectId);

/**
 * Whether the board of a project refreshes on the event. A line of a run's log changes nothing it
 * shows, and a running agent sends one per line, so it is left to the run's own log.
 */
export const refreshesBoard = (event: LiveEvent, projectId: string | null) =>
  refreshesAll(event) || (event.kind !== 'run' && event.projectId === projectId);

/** Whether an open task refreshes on the event; a line of one of its runs' logs is the log's own. */
export const refreshesTask = (event: LiveEvent, projectId: string | null, number: number) =>
  refreshesProject(event, projectId) ||
  (event.kind === 'task' && event.projectId === projectId && event.number === number);

/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  EVERY_PROJECT,
  refreshesBoard,
  refreshesTask,
  type LiveEvent
} from '../src/lib/live-events';

const task = (projectId: string, number: number): LiveEvent => ({
  kind: 'task',
  projectId,
  number
});
const logLine = (projectId: string, number: number): LiveEvent => ({
  kind: 'run',
  projectId,
  number,
  runId: 'r1'
});
const reconnect = task(EVERY_PROJECT, 0);
const members: LiveEvent = { kind: 'members', projectId: 'p' };

describe('refreshesBoard', () => {
  test("a change to a task, a run or a member of the project refreshes the project's board", () => {
    expect(refreshesBoard(task('p', 3), 'p')).toBe(true);
    expect(refreshesBoard(members, 'p')).toBe(true);
    expect(refreshesBoard(reconnect, 'p')).toBe(true);
  });

  test("a line of a run's log, or another project's change, does not", () => {
    expect(refreshesBoard(logLine('p', 3), 'p')).toBe(false);
    expect(refreshesBoard(task('q', 3), 'p')).toBe(false);
  });
});

describe('refreshesTask', () => {
  test('a change to the open task, a member of its project or a reconnect refreshes it', () => {
    expect(refreshesTask(task('p', 3), 'p', 3)).toBe(true);
    expect(refreshesTask(members, 'p', 3)).toBe(true);
    expect(refreshesTask(reconnect, 'p', 3)).toBe(true);
  });

  test("a line of its runs' logs, or a change to another task, does not", () => {
    expect(refreshesTask(logLine('p', 3), 'p', 3)).toBe(false);
    expect(refreshesTask(task('p', 4), 'p', 3)).toBe(false);
    expect(refreshesTask(task('q', 3), 'p', 3)).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import { eachTaskOnItsOwn } from '../src/each-task';

describe('eachTaskOnItsOwn', () => {
  test('a task that throws, at once or later, with any value, is recorded and the rest still run', async () => {
    const ran: string[] = [];
    const failures = await eachTaskOnItsOwn(['a', 'b', 'c', 'd'], (taskId) => {
      ran.push(taskId);
      if (taskId === 'a') throw new Error('broken');
      if (taskId === 'b') throw null;
      if (taskId === 'c') return Promise.reject('refused');
      return Promise.resolve();
    });
    expect(ran).toEqual(['a', 'b', 'c', 'd']);
    expect(failures).toEqual([
      { taskId: 'a', error: 'broken' },
      { taskId: 'b', error: 'null' },
      { taskId: 'c', error: 'refused' }
    ]);
  });
});

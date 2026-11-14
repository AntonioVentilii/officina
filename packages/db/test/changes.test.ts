import { afterAll, describe, expect, test } from 'bun:test';
import { Client, Pool, type Notification } from 'pg';
import { CHANGE_CHANNEL, createTask, listenForChanges } from '../src';
import { resetAndSeed } from './seed';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('change channel', () => {
  const pool = new Pool({ connectionString: url });

  afterAll(async () => {
    await pool.end();
  });

  test('a new task is announced on the channel a listening connection subscribes to', async () => {
    const { projectId, ownerId } = await resetAndSeed(pool);
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await listenForChanges(client);
      const announced = new Promise<Notification>((resolve) => client.on('notification', resolve));
      const { task } = await createTask(pool, {
        projectId,
        title: 'Fix copy',
        requesterId: ownerId
      });
      const notification = await announced;
      expect(notification.channel).toBe(CHANGE_CHANNEL);
      expect(JSON.parse(notification.payload!)).toEqual({ kind: 'task', taskId: task.id });
    } finally {
      await client.end();
    }
  });
});

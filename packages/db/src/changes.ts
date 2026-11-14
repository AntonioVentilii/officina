import type { ClientBase } from 'pg';

/**
 * The channel the database announces task and run changes on. Migration 0005 (`officina_notify`)
 * spells it out, since an applied migration never changes; code that listens reads it here.
 */
export const CHANGE_CHANNEL = 'officina';

/** Subscribes a connection of its own to the change channel. */
export const listenForChanges = async (client: ClientBase): Promise<void> => {
  await client.query(`listen ${CHANGE_CHANNEL}`);
};

/** A trivial query that keeps a connection that only listens from looking idle. */
export const pingConnection = async (client: ClientBase): Promise<void> => {
  await client.query('select 1');
};

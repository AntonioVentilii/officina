import type { ClientBase } from 'pg';

/**
 * The channel the database announces task and run changes on. Migration 0005 (`officina_notify`)
 * spells it out, since an applied migration never changes; code that listens or announces reads it
 * here.
 */
export const CHANGE_CHANNEL = 'officina';

/**
 * Announces that something every view of a member shows (their name) changed, once for each project
 * they are in, so the boards open on those projects refresh. It takes the writer's transaction:
 * Postgres delivers the announcement only once that commits, and never if it rolls back.
 */
export const announceMemberChange = async (client: ClientBase, memberId: string): Promise<void> => {
  await client.query(
    `select pg_notify($1, json_build_object('kind', 'members', 'projectId', project_id)::text)
     from project_roles where member_id = $2`,
    [CHANGE_CHANNEL, memberId]
  );
};

/** Subscribes a connection of its own to the change channel. */
export const listenForChanges = async (client: ClientBase): Promise<void> => {
  await client.query(`listen ${CHANGE_CHANNEL}`);
};

/** A trivial query that keeps a connection that only listens from looking idle. */
export const pingConnection = async (client: ClientBase): Promise<void> => {
  await client.query('select 1');
};

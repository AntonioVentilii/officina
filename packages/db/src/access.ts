import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

/**
 * Every kind of access event. `via` says who acted when it was not the member themselves: a
 * member (`actor`) or the server's CLI.
 */
export const ACCESS_EVENT_TYPES = [
  'signed_in',
  'signed_out',
  'invited',
  'sign_in_link_created',
  'github_linked',
  'github_unlinked',
  'connector_allowed',
  'connector_refused',
  'connector_used',
  'connector_revoked'
] as const;
export type AccessEventType = (typeof ACCESS_EVENT_TYPES)[number];

/** Who did it, when not the member themselves. */
export type AccessActor = { readonly memberId: string } | 'cli' | null;

export interface AccessEventInput {
  readonly memberId: string;
  readonly type: AccessEventType;
  readonly detail?: Readonly<Record<string, string>>;
  readonly actor?: AccessActor;
}

const actorDetail = (actor: AccessActor | undefined) => (actor === 'cli' ? { via: 'cli' } : {});
const actorId = (actor: AccessActor | undefined) =>
  actor && actor !== 'cli' ? actor.memberId : null;

export const recordAccessEvent = async (db: Queryable, event: AccessEventInput) => {
  await db.query(
    `insert into access_events (member_id, actor_member_id, type, detail)
     values ($1, $2, $3, $4)`,
    [
      event.memberId,
      actorId(event.actor),
      event.type,
      JSON.stringify({ ...event.detail, ...actorDetail(event.actor) })
    ]
  );
};

/**
 * Records that a member used Officina from a connector app, at most once a day per app: an app
 * refreshes its token every hour it is in use, and the log should say which days it was used, not
 * each hour. The app is told apart by its client id, since two apps may share a name; the name is
 * kept only for the sentence. The day's row is a unique key (migration 0018), so two refreshes at
 * the same moment still leave one.
 */
export const recordConnectorUse = async (
  db: Queryable,
  use: { readonly memberId: string; readonly clientId: string; readonly clientName: string }
) => {
  await db.query(
    `insert into access_events (member_id, type, detail)
     values ($1, 'connector_used', jsonb_build_object('clientId', $2::text, 'client', $3::text))
     on conflict (member_id, (detail ->> 'clientId'), ((created_at at time zone 'UTC')::date))
       where type = 'connector_used'
     do nothing`,
    [use.memberId, use.clientId, use.clientName]
  );
};

export interface AccessEventRow {
  readonly id: string;
  readonly at: Date;
  readonly type: AccessEventType;
  readonly member: string;
  readonly actor: string | null;
  readonly detail: Readonly<Record<string, string>>;
}

/**
 * The latest access events of a project's members, newest first. A member of another project in
 * the workspace stays out.
 */
export const listAccessEvents = async (
  db: Queryable,
  projectId: string,
  limit: number
): Promise<AccessEventRow[]> =>
  (
    await db.query<AccessEventRow>(
      `select e.id::text as id, e.created_at as at, e.type, m.display_name as member,
              a.display_name as actor, e.detail
       from access_events e
       join members m on m.id = e.member_id
       left join members a on a.id = e.actor_member_id
       where e.member_id in (select member_id from project_roles where project_id = $1)
       order by e.created_at desc, e.id desc
       limit $2`,
      [projectId, limit]
    )
  ).rows;

/** Drops events older than a year: enough to answer "who had access when", short of forever. */
export const purgeOldAccessEvents = async (db: Queryable): Promise<number> =>
  (await db.query(`delete from access_events where created_at < now() - interval '1 year'`))
    .rowCount ?? 0;

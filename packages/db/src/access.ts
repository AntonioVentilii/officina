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
 * Records an event at most once a day for the same member, type and detail: a connector refreshes
 * its token every hour it is in use, and the log should say which days it was used, not each hour.
 */
export const recordDailyAccessEvent = async (db: Queryable, event: AccessEventInput) => {
  const detail = JSON.stringify(event.detail ?? {});
  await db.query(
    `insert into access_events (member_id, type, detail)
     select $1, $2, $3::jsonb
     where not exists (
       select 1 from access_events
       where member_id = $1 and type = $2 and detail = $3::jsonb
         and created_at >= date_trunc('day', now()))`,
    [event.memberId, event.type, detail]
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

import { ROLES, can } from '@officina/core';
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export const NOTIFICATION_KINDS = ['invite_accepted'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationRow {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

/** A member's unread notifications about one project, newest first. */
export const listUnreadNotifications = async (
  db: Queryable,
  memberId: string,
  projectId: string
): Promise<NotificationRow[]> =>
  (
    await db.query<NotificationRow>(
      `select id, kind, payload, created_at as "createdAt" from notifications
       where member_id = $1 and project_id = $2 and read_at is null and kind = any($3::text[])
       order by created_at desc`,
      [memberId, projectId, NOTIFICATION_KINDS]
    )
  ).rows;

/** Marks one of the member's own notifications read; false when they have no such notification. */
export const markNotificationRead = async (
  db: Queryable,
  memberId: string,
  id: string
): Promise<boolean> =>
  (
    await db.query(
      'update notifications set read_at = coalesce(read_at, now()) where id = $1 and member_id = $2',
      [id, memberId]
    )
  ).rowCount === 1;

/** Whoever may invite members is told when an invite is accepted. */
const INVITERS = ROLES.filter((role) => can({ role }, 'manage_members'));

/**
 * Tells everyone who may invite members to a project the member belongs to, other than the member,
 * that the member accepted their invite. Returns how many notifications went out.
 */
export const notifyInviteAccepted = async (
  db: Queryable,
  member: { id: string; name: string }
): Promise<number> =>
  (
    await db.query(
      `insert into notifications (member_id, project_id, kind, payload)
       select inviter.member_id, p.id, $3, jsonb_build_object('memberName', $2::text, 'projectName', p.name)
       from project_roles mine
       join projects p on p.id = mine.project_id
       join project_roles inviter
         on inviter.project_id = p.id and inviter.role = any($4::text[])
        and inviter.member_id <> mine.member_id
       where mine.member_id = $1`,
      [member.id, member.name, 'invite_accepted' satisfies NotificationKind, INVITERS]
    )
  ).rowCount ?? 0;

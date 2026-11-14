import { listUnreadNotifications, type NotificationKind } from '@officina/db';
import type { Pool } from 'pg';

export interface NotificationView {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly text: string;
  readonly createdAt: Date;
}

type Payload = Readonly<Record<string, unknown>>;

/** The only place a notification is put into words. */
const NOTIFICATION_TEXT: Record<NotificationKind, (payload: Payload) => string> = {
  invite_accepted: (payload) =>
    `${String(payload.memberName)} accepted the invite to ${String(payload.projectName)}`
};

/** What the board's Inbox lists above the tasks: the member's unread notifications in a project. */
export const notificationsView = async (
  pool: Pool,
  memberId: string,
  projectId: string
): Promise<NotificationView[]> =>
  (await listUnreadNotifications(pool, memberId, projectId)).map((row) => ({
    id: row.id,
    kind: row.kind,
    text: NOTIFICATION_TEXT[row.kind](row.payload),
    createdAt: row.createdAt
  }));

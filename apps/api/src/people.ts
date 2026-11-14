import { ROLES, can, type Role } from '@officina/core';
import {
  createInviteLink,
  createLoginLink,
  findMemberByEmail,
  listAccessEvents,
  listMemberActivity,
  recordAccessEvent,
  resolveProjectId,
  resolveProjectMember,
  setProjectRole,
  upsertMember,
  loadProject,
  type AccessEventRow,
  type AccessEventType,
  type MemberActivity
} from '@officina/db';
import type { Pool } from 'pg';
import { TaskCommandError } from './tasks';

const SIGN_IN_TTL_MS = 30 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The token rides in the fragment, which browsers never send to servers or put in referrers. */
export const signInUrl = (publicUrl: string, token: string) =>
  `${publicUrl.replace(/\/$/, '')}/signin#${token}`;

const projectFor = async (pool: Pool, repo: string | undefined) => {
  const projectId = await resolveProjectId(pool, repo);
  if (!projectId)
    throw new TaskCommandError(
      repo ? `no project for ${repo}` : 'several projects exist; pass --repo'
    );
  return { projectId, workspaceId: (await loadProject(pool, projectId))!.workspaceId };
};

/** A one-time sign-in link for an existing member (the project owner by default). */
export const loginLink = async (
  pool: Pool,
  input: { publicUrl: string; email?: string | undefined; repo?: string | undefined }
): Promise<string> => {
  let memberId: string | null;
  if (input.email) {
    memberId = (await findMemberByEmail(pool, input.email))?.id ?? null;
  } else {
    const { projectId } = await projectFor(pool, input.repo);
    memberId = await resolveProjectMember(pool, projectId);
  }
  if (!memberId) throw new TaskCommandError(`${input.email ?? 'the owner'} is not a member`);
  const token = await createLoginLink(pool, memberId, SIGN_IN_TTL_MS);
  // Only the CLI on the server mints these: it is how someone who can reach the server gets in.
  await recordAccessEvent(pool, { memberId, type: 'sign_in_link_created', actor: 'cli' });
  return signInUrl(input.publicUrl, token);
};

/** Adds a person to a project with a role (or changes it) and returns their first sign-in link. */
export const invite = async (
  pool: Pool,
  input: {
    publicUrl: string;
    email: string;
    name: string;
    role: string;
    domains: readonly string[];
    repo?: string | undefined;
  }
): Promise<string> => {
  if (!(ROLES as readonly string[]).includes(input.role))
    throw new TaskCommandError(`--role must be one of ${ROLES.join(', ')}`);
  const { projectId, workspaceId } = await projectFor(pool, input.repo);
  const memberId = await upsertMember(pool, {
    workspaceId,
    email: input.email,
    displayName: input.name
  });
  await setProjectRole(pool, {
    projectId,
    memberId,
    role: input.role as Role,
    domains: input.domains
  });
  const token = await createLoginLink(pool, memberId, INVITE_TTL_MS);
  await recordAccessEvent(pool, {
    memberId,
    type: 'invited',
    detail: { role: input.role, project: (await loadProject(pool, projectId))!.repo },
    actor: 'cli'
  });
  return signInUrl(input.publicUrl, token);
};

export interface MemberView extends MemberActivity {
  /** Whether this viewer may send them a fresh invite link from the board. */
  readonly invitable: boolean;
}

/**
 * A sign-in link signs in as its member, so only an owner, who could invite them, may send another,
 * and only to someone who never signed in: a member who has signed in has their own way back in.
 */
const mayInviteAgain = (viewerRole: Role, member: MemberActivity) =>
  can({ role: viewerRole }, 'manage_members') && member.firstSignedInAt === null;

/** The project's members as the board's Members page shows them to an owner or maintainer. */
export const membersView = async (
  pool: Pool,
  projectId: string,
  viewerRole: Role
): Promise<MemberView[]> =>
  (await listMemberActivity(pool, projectId)).map((member) => ({
    ...member,
    invitable: mayInviteAgain(viewerRole, member)
  }));

/** A fresh invite link for a member who has not signed in yet, valid as long as a first invite. */
export const inviteAgain = async (
  pool: Pool,
  input: {
    publicUrl: string;
    projectId: string;
    viewerRole: Role;
    viewerId: string;
    memberId: string;
  }
): Promise<string> => {
  if (!can({ role: input.viewerRole }, 'manage_members'))
    throw new TaskCommandError('only owners send invite links', 403);
  const result = await createInviteLink(pool, { ...input, ttlMs: INVITE_TTL_MS });
  if (result.ok) {
    await recordAccessEvent(pool, {
      memberId: input.memberId,
      type: 'sign_in_link_created',
      actor: { memberId: input.viewerId }
    });
    return signInUrl(input.publicUrl, result.token);
  }
  if (result.error === 'not_member') throw new TaskCommandError('member not found', 404);
  throw new TaskCommandError(`${result.name} has already signed in`);
};

const at = (date: Date) => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const linkUse = (link: MemberActivity['link']): string => {
  if (!link) return '-';
  if (link.usedAt) return at(link.usedAt);
  return link.state === 'expired'
    ? `expired ${at(link.expiresAt)}`
    : `not yet (valid until ${at(link.expiresAt)})`;
};

const table = (rows: readonly (readonly string[])[]): string => {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join('  ')
        .trimEnd()
    )
    .join('\n');
};

/**
 * The `members` command: who is in the project, when they first signed in, their latest link and
 * whether they used it, their last request to the board (while a session is live) and Claude.
 */
export const membersText = async (pool: Pool, input: { repo?: string | undefined }) => {
  const { projectId } = await projectFor(pool, input.repo);
  const members = await listMemberActivity(pool, projectId);
  return table([
    ['NAME', 'ROLE', 'JOINED', 'LINK SENT', 'LINK USED', 'LAST SEEN', 'CLAUDE'],
    ...members.map((member) => [
      member.name,
      member.role,
      member.firstSignedInAt ? at(member.firstSignedInAt) : 'not yet',
      member.link ? at(member.link.createdAt) : '-',
      linkUse(member.link),
      member.lastSeenAt ? at(member.lastSeenAt) : '-',
      member.claudeConnected ? 'connected' : 'no'
    ])
  ]);
};

/** How many access events the board and the CLI show: enough for a few weeks of a small team. */
const ACCESS_LOG_LIMIT = 200;

const METHODS: Readonly<Record<string, string>> = {
  link: 'with a sign-in link',
  github: 'with GitHub'
};

type Detail = AccessEventRow['detail'];

/** Each kind of access event as words about its member; `by` names who did it for them, if anyone. */
const ACCESS_SENTENCES: Readonly<Record<AccessEventType, (d: Detail, by: string) => string>> = {
  signed_in: (d) =>
    `signed in ${METHODS[d.method ?? ''] ?? ''}${d.login ? ` (@${d.login})` : ''}`.trim(),
  signed_out: () => 'signed out',
  invited: (d, by) => `was invited to ${d.project} as ${d.role}${by}`,
  sign_in_link_created: (_, by) => `was sent a sign-in link${by}`,
  github_linked: (d) => `connected GitHub as @${d.login}`,
  github_unlinked: (d) => `disconnected GitHub @${d.login}`,
  connector_allowed: (d) => `allowed ${d.client} to use Officina as them`,
  connector_refused: (d) => `refused ${d.client}`,
  connector_used: (d) => `used Officina from ${d.client}`,
  connector_revoked: (d) =>
    `lost ${d.client}'s access: a spent token was presented again, so it must reconnect`
};

/** One access event as a sentence about its member, for the board and the CLI alike. */
export const describeAccessEvent = (event: AccessEventRow): string => {
  const by = event.actor
    ? ` by ${event.actor}`
    : event.detail.via === 'cli'
      ? ' from the server CLI'
      : '';
  return ACCESS_SENTENCES[event.type](event.detail, by);
};

/** The project's access log, newest first, as the owners' Members page shows it. */
export const accessLogView = async (pool: Pool, projectId: string) =>
  (await listAccessEvents(pool, projectId, ACCESS_LOG_LIMIT)).map((event) => ({
    id: event.id,
    at: event.at,
    type: event.type,
    member: event.member,
    text: describeAccessEvent(event)
  }));

/** The `access-log` command: the same log for owners at the server. */
export const accessLogText = async (pool: Pool, input: { repo?: string | undefined }) => {
  const { projectId } = await projectFor(pool, input.repo);
  const events = await accessLogView(pool, projectId);
  if (events.length === 0) return 'No access events yet.';
  return table([
    ['WHEN', 'WHO', 'WHAT'],
    ...events.map((event) => [at(event.at), event.member, event.text])
  ]);
};

import { ROLES, type Role } from '@officina/core';
import {
  createInviteLink,
  createLoginLink,
  findMemberByEmail,
  listMemberActivity,
  resolveProjectId,
  resolveProjectMember,
  setProjectRole,
  upsertMember,
  loadProject,
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
  return signInUrl(input.publicUrl, await createLoginLink(pool, memberId, SIGN_IN_TTL_MS));
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
  return signInUrl(input.publicUrl, await createLoginLink(pool, memberId, INVITE_TTL_MS));
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
  viewerRole === 'owner' && member.firstSignedInAt === null;

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
  input: { publicUrl: string; projectId: string; viewerRole: Role; memberId: string }
): Promise<string> => {
  if (input.viewerRole !== 'owner')
    throw new TaskCommandError('only owners send invite links', 403);
  const result = await createInviteLink(pool, { ...input, ttlMs: INVITE_TTL_MS });
  if (result.ok) return signInUrl(input.publicUrl, result.token);
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

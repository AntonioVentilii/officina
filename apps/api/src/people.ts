import { ROLES, type Role } from '@officina/core';
import {
  createLoginLink,
  findMemberByEmail,
  resolveProjectId,
  resolveProjectMember,
  setProjectRole,
  upsertMember,
  loadProject
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

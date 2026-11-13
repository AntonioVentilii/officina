import { randomBytes } from 'node:crypto';
import { allowedActions } from '@officina/core';
import {
  consumeOAuthState,
  createOAuthState,
  createSession,
  githubLoginOf,
  unlinkGitHubAccount,
  endSession,
  listMemberProjects,
  loadRun,
  markNotificationRead,
  memberForSession,
  redeemLoginLink,
  SESSION_TTL_MS,
  spendOAuthState,
  type MemberProject,
  type SessionMember
} from '@officina/db';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  agentsView,
  boardView,
  learningsView,
  roleLabels,
  runLog,
  runsView,
  seesTechnical,
  taskView,
  type BoardViewer
} from './board';
import { checkAuthorization, consentRedirect } from './connector';
import type { GitHubAccounts } from './github-accounts';
import { decide as decideLearning, type LearningGitHub } from './learnings';
import { notificationsView } from './notifications';
import { inviteAgain, membersView } from './people';
import type { BoardEvent, RealtimeHub } from './realtime';
import {
  TaskCommandError,
  actOnTaskAs,
  commentAs,
  createRequestAs,
  type TaskAction
} from './tasks';

export interface BoardApiDependencies {
  readonly pool: Pool;
  readonly publicUrl: string;
  readonly consoleWorkspace?: string | undefined;
  readonly realtime?: RealtimeHub | undefined;
  /** Opens the pull requests of accepted learnings. */
  readonly github?: LearningGitHub | undefined;
  /** Linking members' GitHub accounts and signing in with GitHub; off when the app has no client secret. */
  readonly githubLogin?:
    | { readonly accounts: GitHubAccounts; readonly authorizeUrl: (state: string) => string }
    | undefined;
}

const COOKIE = 'officina_session';
const OAUTH_COOKIE = 'officina_oauth';
/** Where a GitHub sign-in returns to, such as the connector's consent page. */
const NEXT_COOKIE = 'officina_next';
const OAUTH_TTL_MS = 10 * 60 * 1000;
/**
 * A sign-in needs no session, so its state is not stored when the flow starts (anyone could fill
 * the table): it carries its own expiry, is bound to the browser by the cookie, and is recorded
 * once GitHub accepts the code that came back with it, before anything else is written.
 */
const SIGNIN_PREFIX = 's.';
const signinState = () =>
  `${SIGNIN_PREFIX}${Date.now() + OAUTH_TTL_MS}.${randomBytes(24).toString('base64url')}`;
const signinExpiry = (state: string): Date | null => {
  const expires = Number(state.slice(SIGNIN_PREFIX.length).split('.')[0]);
  return Number.isSafeInteger(expires) &&
    expires > Date.now() &&
    expires <= Date.now() + OAUTH_TTL_MS
    ? new Date(expires)
    : null;
};
/**
 * State-changing requests must carry this header. Browsers only send custom headers cross-origin
 * after a CORS preflight, which this API never grants, so another site cannot forge a request.
 */
const REQUEST_HEADER = 'x-officina-request';
const HEARTBEAT_MS = 25_000;

const readCookie = (request: Request, cookie = COOKIE): string | null => {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === cookie) return value.join('=') || null;
  }
  return null;
};

const redirect = (location: string, cookies: readonly string[] = []) => {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
};

const sessionCookie = (value: string, maxAgeMs: number, secure: boolean) =>
  [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    secure ? 'Secure' : null
  ]
    .filter(Boolean)
    .join('; ');

const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('submit') }),
  z.strictObject({ type: z.literal('accept') }),
  z.strictObject({ type: z.literal('claim') }),
  z.strictObject({ type: z.literal('approve') }),
  z.strictObject({ type: z.literal('changes'), note: z.string().trim().min(1).max(10_000) }),
  z.strictObject({ type: z.literal('answer'), text: z.string().trim().min(1).max(10_000) }),
  z.strictObject({ type: z.literal('decline'), reason: z.string().trim().min(1).max(2_000) }),
  z.strictObject({ type: z.literal('cancel'), reason: z.string().trim().min(1).max(2_000) })
]);

const requestSchema = z.strictObject({
  title: z.string().trim().min(3).max(200),
  request: z.string().trim().min(1).max(20_000),
  interview: z.boolean().optional()
});

const commentSchema = z.strictObject({ body: z.string().trim().min(1).max(20_000) });

/** Only a path on this site, so a sign-in can never be turned into a redirect elsewhere. */
const localPath = (value: unknown): string | null =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  !value.startsWith('//') &&
  !value.includes('\\') &&
  value.length <= 4_000
    ? value
    : null;

const consentSchema = z.strictObject({
  params: z.record(z.string(), z.string().max(4_000)),
  allow: z.boolean()
});

const learningDecisionSchema = z.strictObject({
  decision: z.enum(['accept', 'reject']),
  note: z.string().trim().max(2_000).optional()
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

interface Signed {
  readonly member: SessionMember;
  readonly projects: readonly MemberProject[];
}

export const createBoardApi = (deps: BoardApiDependencies) => {
  const { pool } = deps;
  const secure = deps.publicUrl.startsWith('https://');

  const signedIn = async (request: Request): Promise<Signed> => {
    const token = readCookie(request);
    const member = token ? await memberForSession(pool, token) : null;
    if (!member) throw new HttpError(401, 'sign in first');
    return { member, projects: await listMemberProjects(pool, member.id) };
  };

  const technicalViewer = (viewer: BoardViewer): BoardViewer => {
    if (!seesTechnical(viewer)) throw new HttpError(403, 'only maintainers and owners see this');
    return viewer;
  };

  const viewerFor = (signed: Signed, projectId: string): BoardViewer => {
    const project = signed.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new HttpError(404, 'project not found');
    return {
      memberId: signed.member.id,
      workspaceId: signed.member.workspaceId,
      projectId,
      role: project.role,
      domains: project.domains
    };
  };

  const mutation = (request: Request) => {
    if (request.headers.get(REQUEST_HEADER) !== '1')
      throw new HttpError(403, 'missing request header');
  };

  const taskNumber = (raw: string) => {
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 1) throw new HttpError(404, 'task not found');
    return number;
  };

  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new HttpError(400, parsed.error.issues.map((issue) => issue.message).join('; '));
    return parsed.data;
  };

  const stream = (signed: Signed, request: Request) => {
    const projectIds = new Set(signed.projects.map((project) => project.id));
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            cleanup();
          }
        };
        send(': connected\n\n');
        const unsubscribe =
          deps.realtime?.subscribe((event: BoardEvent) => {
            if (projectIds.has(event.projectId))
              send(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
          }) ?? (() => {});
        // Proxies close idle connections; a comment line every so often keeps the stream open.
        const heartbeat = setInterval(() => send(': ping\n\n'), HEARTBEAT_MS);
        cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
        };
        request.signal.addEventListener('abort', () => {
          cleanup();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
      cancel() {
        cleanup();
      }
    });
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      }
    });
  };

  return (
    new Elysia()
      .error({ HttpError, TaskCommandError })
      .onError(({ code, error, set }) => {
        if (code === 'HttpError') {
          set.status = error.status;
          return { error: error.message };
        }
        if (code === 'TaskCommandError') {
          set.status = error.status;
          return { error: error.message };
        }
      })
      .post('/auth/redeem', async ({ body, request, set }) => {
        mutation(request);
        const { token } = parse(z.strictObject({ token: z.string().min(20).max(200) }), body);
        const redeemed = await redeemLoginLink(pool, token);
        if (!redeemed)
          throw new HttpError(410, 'this sign-in link was already used or has expired');
        set.headers['set-cookie'] = sessionCookie(redeemed.sessionToken, SESSION_TTL_MS, secure);
        return { ok: true };
      })
      .post('/auth/sign-out', async ({ request, set }) => {
        mutation(request);
        const token = readCookie(request);
        if (token) await endSession(pool, token);
        set.headers['set-cookie'] = sessionCookie('', 0, secure);
        return { ok: true };
      })
      .get('/auth/options', () => ({ github: Boolean(deps.githubLogin) }))
      // GitHub authorization: `link` connects the signed-in member's account, `signin` signs in with
      // an account linked before. The state is single-use and bound to this browser by a cookie.
      .get('/auth/github/start', async ({ request, query }) => {
        if (!deps.githubLogin) throw new HttpError(404, 'GitHub sign-in is not configured');
        let state = signinState();
        if (query.mode === 'link') {
          const memberId = (await signedIn(request)).member.id;
          state = randomBytes(24).toString('base64url');
          await createOAuthState(pool, state, memberId, OAUTH_TTL_MS);
        }
        const cookie = (name: string, value: string) =>
          [
            `${name}=${value}`,
            'Path=/auth/github',
            'HttpOnly',
            'SameSite=Lax',
            `Max-Age=${OAUTH_TTL_MS / 1000}`,
            secure ? 'Secure' : null
          ]
            .filter(Boolean)
            .join('; ');
        const next = localPath(query.next);
        return redirect(deps.githubLogin.authorizeUrl(state), [
          cookie(OAUTH_COOKIE, state),
          cookie(NEXT_COOKIE, next ? encodeURIComponent(next) : '')
        ]);
      })
      .get('/auth/github/callback', async ({ request, query }) => {
        if (!deps.githubLogin) throw new HttpError(404, 'GitHub sign-in is not configured');
        const clear = `${OAUTH_COOKIE}=; Path=/auth/github; HttpOnly; SameSite=Lax; Max-Age=0`;
        const clearNext = `${NEXT_COOKIE}=; Path=/auth/github; HttpOnly; SameSite=Lax; Max-Age=0`;
        const rawNext = readCookie(request, NEXT_COOKIE);
        const next = (rawNext && localPath(decodeURIComponent(rawNext))) || '/';
        const fail = (why: string) =>
          redirect(`/signin?error=${encodeURIComponent(why)}`, [clear, clearNext]);
        const code = typeof query.code === 'string' ? query.code : null;
        const state = typeof query.state === 'string' ? query.state : null;
        if (!code || !state || readCookie(request, OAUTH_COOKIE) !== state)
          return fail('The GitHub sign-in did not match this browser; try again.');
        const expired = () => fail('The GitHub sign-in expired; try again.');
        if (state.startsWith(SIGNIN_PREFIX)) {
          const expiresAt = signinExpiry(state);
          if (!expiresAt) return expired();
          const result = await deps.githubLogin.accounts.complete(code, null, () =>
            spendOAuthState(pool, state, expiresAt)
          );
          if (!result.ok) return fail(result.why);
          const session = await createSession(pool, result.memberId);
          return redirect(next, [clear, clearNext, sessionCookie(session, SESSION_TTL_MS, secure)]);
        }
        const consumed = await consumeOAuthState(pool, state);
        if (!consumed) return expired();
        const result = await deps.githubLogin.accounts.complete(code, consumed.memberId);
        if (!result.ok) return fail(result.why);
        return redirect('/?github=linked', [clear]);
      })
      .post('/auth/github/unlink', async ({ request }) => {
        mutation(request);
        const signed = await signedIn(request);
        await unlinkGitHubAccount(pool, signed.member.id);
        return { ok: true };
      })
      .get('/api/me', async ({ request }) => {
        const signed = await signedIn(request);
        const login = await githubLoginOf(pool, signed.member.id);
        return {
          member: {
            id: signed.member.id,
            name: signed.member.displayName,
            email: signed.member.email
          },
          // What the member may do in each project, from the permission matrix, so the board
          // shows only what the API would accept.
          projects: signed.projects.map((project) => ({
            ...project,
            can: allowedActions(project.role)
          })),
          github: login ? { login } : null,
          githubAvailable: Boolean(deps.githubLogin)
        };
      })
      // The connector's consent step: the person, signed in on the board, allows or refuses an
      // app that asked to act as them through `/oauth/authorize`.
      .get('/api/connector/authorization', async ({ request, query }) => {
        const signed = await signedIn(request);
        const checked = await checkAuthorization(pool, deps.publicUrl, query);
        if (!checked.ok) {
          if (checked.redirectable) return { redirect: checked.redirect };
          throw new HttpError(400, checked.message);
        }
        return {
          client: checked.request.client.name,
          returnsTo: new URL(checked.request.redirectUri).host,
          member: signed.member.displayName,
          projects: signed.projects.map((project) => project.name)
        };
      })
      .post('/api/connector/authorization', async ({ request, body }) => {
        mutation(request);
        const signed = await signedIn(request);
        const { params, allow } = parse(consentSchema, body);
        const checked = await checkAuthorization(pool, deps.publicUrl, params);
        if (!checked.ok) {
          if (checked.redirectable) return { redirect: checked.redirect };
          throw new HttpError(400, checked.message);
        }
        return {
          redirect: await consentRedirect(
            pool,
            deps.publicUrl,
            checked.request,
            allow ? { allow: true, memberId: signed.member.id } : { allow: false }
          )
        };
      })
      .get('/api/stream', async ({ request }) => stream(await signedIn(request), request))
      .get('/api/projects/:projectId/board', async ({ request, params }) => {
        const viewer = viewerFor(await signedIn(request), params.projectId);
        return { tasks: await boardView(pool, viewer), roleLabels: roleLabels() };
      })
      .get('/api/projects/:projectId/runs', async ({ request, params }) => {
        const viewer = technicalViewer(viewerFor(await signedIn(request), params.projectId));
        return { runs: await runsView(pool, viewer, deps.consoleWorkspace), agents: agentsView() };
      })
      .get('/api/projects/:projectId/tasks/:number', async ({ request, params }) => {
        const viewer = viewerFor(await signedIn(request), params.projectId);
        const task = await taskView(pool, viewer, taskNumber(params.number), deps.consoleWorkspace);
        if (!task) throw new HttpError(404, 'task not found');
        return task;
      })
      .get('/api/runs/:runId/log', async ({ request, params, query }) => {
        const signed = await signedIn(request);
        const run = z.uuid().safeParse(params.runId).success
          ? await loadRun(pool, params.runId)
          : null;
        if (!run || !signed.projects.some((project) => project.id === run.projectId))
          throw new HttpError(404, 'run not found');
        technicalViewer(viewerFor(signed, run.projectId));
        const after = Number(query.after ?? 0);
        return runLog(pool, run.id, Number.isInteger(after) && after > 0 ? after : 0);
      })
      .post('/api/projects/:projectId/tasks', async ({ request, params, body }) => {
        mutation(request);
        const viewer = viewerFor(await signedIn(request), params.projectId);
        const { interview, ...input } = parse(requestSchema, body);
        return createRequestAs(pool, {
          projectId: viewer.projectId,
          memberId: viewer.memberId,
          ...input,
          skipInterview: interview === false
        });
      })
      .post('/api/projects/:projectId/tasks/:number/actions', async ({ request, params, body }) => {
        mutation(request);
        const viewer = viewerFor(await signedIn(request), params.projectId);
        const action = parse(actionSchema, body) as TaskAction;
        return actOnTaskAs(pool, {
          projectId: viewer.projectId,
          memberId: viewer.memberId,
          number: taskNumber(params.number),
          action
        });
      })
      .get('/api/projects/:projectId/learnings', async ({ request, params }) => {
        const viewer = technicalViewer(viewerFor(await signedIn(request), params.projectId));
        return { learnings: await learningsView(pool, viewer) };
      })
      .post('/api/projects/:projectId/learnings/:learningId', async ({ request, params, body }) => {
        mutation(request);
        const viewer = viewerFor(await signedIn(request), params.projectId);
        if (!z.uuid().safeParse(params.learningId).success)
          throw new HttpError(404, 'learning not found');
        const input = parse(learningDecisionSchema, body);
        await decideLearning(
          pool,
          deps.github,
          {
            projectId: viewer.projectId,
            memberId: viewer.memberId,
            role: viewer.role,
            publicUrl: deps.publicUrl
          },
          { id: params.learningId, ...input }
        );
        return { ok: true };
      })
      .get('/api/projects/:projectId/members', async ({ request, params }) => {
        const viewer = technicalViewer(viewerFor(await signedIn(request), params.projectId));
        return { members: await membersView(pool, viewer.projectId, viewer.role) };
      })
      .post('/api/projects/:projectId/members/:memberId/link', async ({ request, params }) => {
        mutation(request);
        const viewer = viewerFor(await signedIn(request), params.projectId);
        if (!z.uuid().safeParse(params.memberId).success)
          throw new HttpError(404, 'member not found');
        return {
          url: await inviteAgain(pool, {
            publicUrl: deps.publicUrl,
            projectId: viewer.projectId,
            viewerRole: viewer.role,
            memberId: params.memberId
          })
        };
      })
      .get('/api/projects/:projectId/notifications', async ({ request, params }) => {
        const viewer = viewerFor(await signedIn(request), params.projectId);
        return {
          notifications: await notificationsView(pool, viewer.memberId, viewer.projectId)
        };
      })
      .post('/api/notifications/:notificationId/read', async ({ request, params }) => {
        mutation(request);
        const signed = await signedIn(request);
        const found =
          z.uuid().safeParse(params.notificationId).success &&
          (await markNotificationRead(pool, signed.member.id, params.notificationId));
        if (!found) throw new HttpError(404, 'notification not found');
        return { ok: true };
      })
      .post(
        '/api/projects/:projectId/tasks/:number/comments',
        async ({ request, params, body }) => {
          mutation(request);
          const viewer = viewerFor(await signedIn(request), params.projectId);
          const { body: text } = parse(commentSchema, body);
          await commentAs(pool, {
            projectId: viewer.projectId,
            memberId: viewer.memberId,
            number: taskNumber(params.number),
            text
          });
          return { ok: true };
        }
      )
  );
};

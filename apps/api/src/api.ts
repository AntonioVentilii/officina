import {
  addComment,
  endSession,
  findTaskIdByNumber,
  listMemberProjects,
  loadRun,
  memberForSession,
  redeemLoginLink,
  SESSION_TTL_MS,
  type MemberProject,
  type SessionMember
} from '@officina/db';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { z } from 'zod';
import { boardView, runLog, runsView, taskView, type BoardViewer } from './board';
import type { BoardEvent, RealtimeHub } from './realtime';
import { TaskCommandError, actOnTaskAs, createRequestAs, type TaskAction } from './tasks';

export interface BoardApiDependencies {
  readonly pool: Pool;
  readonly publicUrl: string;
  readonly consoleWorkspace?: string | undefined;
  readonly realtime?: RealtimeHub | undefined;
}

const COOKIE = 'officina_session';
/**
 * State-changing requests must carry this header. Browsers only send custom headers cross-origin
 * after a CORS preflight, which this API never grants, so another site cannot forge a request.
 */
const REQUEST_HEADER = 'x-officina-request';
const HEARTBEAT_MS = 25_000;

const readCookie = (request: Request): string | null => {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=') || null;
  }
  return null;
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
  z.strictObject({ type: z.literal('accept') }),
  z.strictObject({ type: z.literal('approve') }),
  z.strictObject({ type: z.literal('changes'), note: z.string().trim().min(1).max(10_000) }),
  z.strictObject({ type: z.literal('answer'), text: z.string().trim().min(1).max(10_000) }),
  z.strictObject({ type: z.literal('decline'), reason: z.string().trim().min(1).max(2_000) }),
  z.strictObject({ type: z.literal('cancel'), reason: z.string().trim().min(1).max(2_000) })
]);

const requestSchema = z.strictObject({
  title: z.string().trim().min(3).max(200),
  request: z.string().trim().min(1).max(20_000)
});

const commentSchema = z.strictObject({ body: z.string().trim().min(1).max(20_000) });

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

  return new Elysia()
    .error({ HttpError, TaskCommandError })
    .onError(({ code, error, set }) => {
      if (code === 'HttpError') {
        set.status = error.status;
        return { error: error.message };
      }
      if (code === 'TaskCommandError') {
        set.status = 409;
        return { error: error.message };
      }
    })
    .post('/auth/redeem', async ({ body, request, set }) => {
      mutation(request);
      const { token } = parse(z.strictObject({ token: z.string().min(20).max(200) }), body);
      const redeemed = await redeemLoginLink(pool, token);
      if (!redeemed) throw new HttpError(410, 'this sign-in link was already used or has expired');
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
    .get('/api/me', async ({ request }) => {
      const signed = await signedIn(request);
      return {
        member: {
          id: signed.member.id,
          name: signed.member.displayName,
          email: signed.member.email
        },
        projects: signed.projects
      };
    })
    .get('/api/stream', async ({ request }) => stream(await signedIn(request), request))
    .get('/api/projects/:projectId/board', async ({ request, params }) => {
      const viewer = viewerFor(await signedIn(request), params.projectId);
      return { tasks: await boardView(pool, viewer) };
    })
    .get('/api/projects/:projectId/runs', async ({ request, params }) => {
      const viewer = viewerFor(await signedIn(request), params.projectId);
      return { runs: await runsView(pool, viewer, deps.consoleWorkspace) };
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
      const after = Number(query.after ?? 0);
      return runLog(pool, run.id, Number.isInteger(after) && after > 0 ? after : 0);
    })
    .post('/api/projects/:projectId/tasks', async ({ request, params, body }) => {
      mutation(request);
      const viewer = viewerFor(await signedIn(request), params.projectId);
      const input = parse(requestSchema, body);
      return createRequestAs(pool, {
        projectId: viewer.projectId,
        memberId: viewer.memberId,
        ...input
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
    .post('/api/projects/:projectId/tasks/:number/comments', async ({ request, params, body }) => {
      mutation(request);
      const viewer = viewerFor(await signedIn(request), params.projectId);
      if (viewer.role === 'watcher') throw new HttpError(403, 'watchers can read but not comment');
      const { body: text } = parse(commentSchema, body);
      const taskId = await findTaskIdByNumber(pool, viewer.projectId, taskNumber(params.number));
      if (!taskId) throw new HttpError(404, 'task not found');
      await addComment(pool, taskId, { kind: 'member', memberId: viewer.memberId }, text);
      return { ok: true };
    });
};

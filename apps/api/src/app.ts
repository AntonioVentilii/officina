import { hasDelivery, recordDelivery } from '@officina/db';
import { parseWebhookEvent, verifyWebhookSignature } from '@officina/github';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { createBoardApi, type BoardApiDependencies } from './api';
import { createBoardServer } from './static';
import { handleWebhookAction, type ConfigReader } from './webhooks';

export interface AppDependencies {
  readonly pool: Pool;
  readonly webhookSecret: string;
  /** Needed to refresh project configs on push; without it config pushes are ignored. */
  readonly github?: ConfigReader;
  /** The board's API; without it only health and webhooks are served. */
  readonly board?: Omit<BoardApiDependencies, 'pool'>;
  /** The board's static build, served for every other path. */
  readonly boardDir?: string;
}

export const createApp = ({ pool, webhookSecret, github, board, boardDir }: AppDependencies) => {
  const serveBoard = boardDir ? createBoardServer(boardDir) : null;
  return new Elysia()
    .use(board ? createBoardApi({ pool, ...board }) : new Elysia())
    .get('/health', () => ({ ok: true }))
    .post(
      '/github/webhook',
      async ({ request, set }) => {
        // The signature covers the exact bytes GitHub sent, so the body is read raw, never re-serialized.
        const raw = await request.text();
        const signature = request.headers.get('x-hub-signature-256');
        if (!verifyWebhookSignature(webhookSecret, raw, signature)) {
          set.status = 401;
          return { error: 'invalid_signature' };
        }
        const deliveryId = request.headers.get('x-github-delivery');
        const event = request.headers.get('x-github-event') ?? 'unknown';
        if (!deliveryId) {
          set.status = 400;
          return { error: 'missing_delivery_id' };
        }
        if (await hasDelivery(pool, deliveryId)) {
          return { status: 'duplicate' };
        }

        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          set.status = 400;
          return { error: 'invalid_json' };
        }

        const action = parseWebhookEvent(event, payload);
        const outcomes = action ? await handleWebhookAction(pool, action, github) : [];
        // Recorded only after processing, so a delivery that failed mid-way is retried by GitHub.
        await recordDelivery(pool, deliveryId, event);
        return { status: action ? 'applied' : 'ignored', outcomes };
      },
      { parse: 'none' }
    )
    .get('/*', ({ request, set }) => {
      if (serveBoard) return serveBoard(new URL(request.url).pathname);
      set.status = 404;
      return { error: 'not found' };
    });
};

export type App = ReturnType<typeof createApp>;

import { hasDelivery, recordDelivery } from '@officina/db';
import { parseWebhookEvent, verifyWebhookSignature } from '@officina/github';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { handleWebhookAction } from './webhooks';

export interface AppDependencies {
  readonly pool: Pool;
  readonly webhookSecret: string;
}

export const createApp = ({ pool, webhookSecret }: AppDependencies) =>
  new Elysia()
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
        const outcomes = action ? await handleWebhookAction(pool, action) : [];
        // Recorded only after processing, so a delivery that failed mid-way is retried by GitHub.
        await recordDelivery(pool, deliveryId, event);
        return { status: action ? 'applied' : 'ignored', outcomes };
      },
      { parse: 'none' }
    );

export type App = ReturnType<typeof createApp>;

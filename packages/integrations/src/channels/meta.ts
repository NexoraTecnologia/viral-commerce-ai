import { z } from 'zod';
import { ok, type Result } from '@vc/shared';
import { headerOf, sha256Hex } from './common';
import type {
  AdapterContext,
  NormalizedWebhookEvent,
  WebhookOutcome,
  WebhookRequest,
} from './types';

/** Versión de Graph API usada en los ejemplos oficiales consultados (2026-11-17). */
export const META_GRAPH_VERSION = 'v27.0';

const Entry = z.object({
  id: z.string().optional(),
  time: z.number().optional(),
  changes: z
    .array(z.object({ field: z.string(), value: z.record(z.string(), z.unknown()).optional() }))
    .optional(),
  messaging: z.array(z.record(z.string(), z.unknown())).optional(),
});
const Envelope = z.object({ object: z.string(), entry: z.array(Entry) });
export type MetaEnvelope = z.output<typeof Envelope>;

/**
 * Webhooks de Meta (Instagram y WhatsApp):
 * - GET de verificación: hub.mode=subscribe + hub.verify_token → devolver hub.challenge.
 * - POST: validar X-Hub-Signature-256 (HMAC-SHA256 del cuerpo crudo con el App Secret).
 * Los reintentos pueden durar hasta 7 días: la idempotencia es obligatoria.
 */
export const handleMetaWebhook = async (
  ctx: AdapterContext,
  request: WebhookRequest,
  toEvents: (envelope: MetaEnvelope, bodyHash: string) => readonly NormalizedWebhookEvent[],
): Promise<Result<WebhookOutcome>> => {
  if (request.method === 'GET') {
    const expected = ctx.credentials.webhookVerifyToken;
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];
    if (!expected || mode !== 'subscribe' || token !== expected || !challenge) {
      return ok({ type: 'rejected', reason: 'Verificación de suscripción inválida' });
    }
    return ok({ type: 'challenge', body: challenge });
  }
  const valid = await ctx.verifySignature(
    ctx.credentials.webhookSecret,
    request.rawBody,
    headerOf(request.headers, 'x-hub-signature-256'),
  );
  if (!valid) return ok({ type: 'rejected', reason: 'Firma X-Hub-Signature-256 inválida' });
  let json: unknown;
  try {
    json = JSON.parse(request.rawBody);
  } catch {
    return ok({ type: 'rejected', reason: 'JSON inválido' });
  }
  const parsed = Envelope.safeParse(json);
  if (!parsed.success) return ok({ type: 'rejected', reason: 'Formato no reconocido' });
  return ok({ type: 'events', events: toEvents(parsed.data, await sha256Hex(request.rawBody)) });
};

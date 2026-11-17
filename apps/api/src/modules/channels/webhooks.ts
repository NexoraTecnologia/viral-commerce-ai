import { and, eq } from 'drizzle-orm';
import {
  channelConnections,
  channelMessages,
  webhookEvents,
  type Database,
  type WebhookEventRow,
} from '@vc/database';
import { createChannelAdapter, type WebhookRequest } from '@vc/integrations';
import { redact } from '@vc/security';
import { appError, err, newId, ok, type ChannelKind, type Result } from '@vc/shared';
import { adapterContext, adapterFor, logged, type ChannelRuntime } from './runtime';
import { upsertOrder } from './service';

export const WEBHOOK_CHANNELS = {
  mercadolibre: 'MERCADO_LIBRE',
  instagram: 'INSTAGRAM',
  whatsapp: 'WHATSAPP',
} as const satisfies Record<string, ChannelKind>;

export type WebhookResponse =
  | { readonly kind: 'challenge'; readonly body: string }
  | {
      readonly kind: 'accepted';
      readonly stored: number;
      readonly duplicates: number;
      readonly routed: { id: string; tenantId: string }[];
    }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Recepción de un webhook (ruta pública). Se valida con el adaptador LIVE del
 * canal (firma / application_id), se guarda con clave de idempotencia y se
 * responde rápido; el procesamiento ocurre en un trabajo del Automation Core.
 */
export const receiveWebhook = async (
  base: Omit<ChannelRuntime, 'tenantId'>,
  channel: ChannelKind,
  request: WebhookRequest,
): Promise<WebhookResponse> => {
  const adapter = createChannelAdapter(
    channel,
    'LIVE',
    adapterContext({ ...base, tenantId: '' }, channel, null),
  );
  const outcome = await adapter.handleWebhook(request);
  if (!outcome.ok) return { kind: 'rejected', reason: outcome.error.message };
  if (outcome.value.type === 'challenge') return { kind: 'challenge', body: outcome.value.body };
  if (outcome.value.type === 'rejected') return { kind: 'rejected', reason: outcome.value.reason };

  let stored = 0;
  let duplicates = 0;
  const routed: { id: string; tenantId: string }[] = [];
  for (const e of outcome.value.events) {
    const connection = e.externalAccountId
      ? await base.db
          .select()
          .from(channelConnections)
          .where(
            and(
              eq(channelConnections.channel, channel),
              eq(channelConnections.mode, 'LIVE'),
              eq(channelConnections.externalAccountId, e.externalAccountId),
            ),
          )
          .get()
      : undefined;
    const id = newId();
    const inserted = await base.db
      .insert(webhookEvents)
      .values({
        id,
        tenantId: connection?.tenantId ?? null,
        channel,
        connectionId: connection?.id ?? null,
        dedupeKey: e.dedupeKey,
        topic: e.topic,
        resource: e.resource,
        payload: redact(e.payload) as Record<string, unknown>,
        status: connection ? 'RECEIVED' : 'IGNORED',
        detail: connection ? null : 'Cuenta externa sin conexión registrada',
        receivedAt: base.now,
      })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (inserted.length === 0) duplicates++;
    else {
      stored++;
      if (connection) routed.push({ id, tenantId: connection.tenantId });
    }
  }
  return { kind: 'accepted', stored, duplicates, routed };
};

const finish = (
  db: Database,
  id: string,
  status: WebhookEventRow['status'],
  detail: string | null,
  now: Date,
) =>
  db
    .update(webhookEvents)
    .set({ status, detail, processedAt: now })
    .where(eq(webhookEvents.id, id));

/**
 * Procesa un evento guardado. Nunca se confía en el contenido de la notificación
 * para datos de negocio: en Mercado Libre se consulta el recurso con nuestro token.
 */
export const processWebhookEvent = async (
  rt: ChannelRuntime,
  eventId: string,
): Promise<Result<{ status: string; detail: string | null }>> => {
  const e = await rt.db
    .select()
    .from(webhookEvents)
    .where(and(eq(webhookEvents.id, eventId), eq(webhookEvents.tenantId, rt.tenantId)))
    .get();
  if (!e) return err(appError('NOT_FOUND', 'Evento inexistente'));
  if (e.status !== 'RECEIVED') return ok({ status: e.status, detail: e.detail });
  const connection = e.connectionId
    ? await rt.db
        .select()
        .from(channelConnections)
        .where(eq(channelConnections.id, e.connectionId))
        .get()
    : undefined;
  if (!connection) {
    await finish(rt.db, e.id, 'IGNORED', 'Sin conexión', rt.now);
    return ok({ status: 'IGNORED', detail: 'Sin conexión' });
  }

  const done = async (status: WebhookEventRow['status'], detail: string | null) => {
    await finish(rt.db, e.id, status, detail, rt.now);
    return ok({ status, detail });
  };

  if (e.channel === 'MERCADO_LIBRE') {
    const orderMatch = /^\/orders\/(\d+)$/.exec(e.resource ?? '');
    if ((e.topic === 'orders_v2' || e.topic === 'orders') && orderMatch?.[1]) {
      const adapter = await adapterFor(rt, connection);
      const orderId = orderMatch[1];
      const order = await logged(rt, connection, 'getOrderStatus', () =>
        adapter.getOrderStatus(orderId),
      );
      if (!order.ok) {
        await finish(rt.db, e.id, 'FAILED', order.error.message, rt.now);
        return order;
      }
      await upsertOrder(rt, connection.id, order.value);
      return done('PROCESSED', `Orden ${orderId}: ${order.value.rawStatus}`);
    }
    if (e.topic === 'questions' || e.topic === 'items')
      return done('PROCESSED', `Cambio en ${e.resource ?? e.topic}: sincronizar desde el panel`);
    return done('IGNORED', `Tópico ${e.topic} no utilizado`);
  }

  if (e.channel === 'WHATSAPP') {
    const p = e.payload as {
      id?: string;
      from?: string;
      from_user_id?: string;
      type?: string;
      text?: { body?: string };
      status?: string;
    };
    if (e.topic === 'messages' && p.id) {
      await rt.db
        .insert(channelMessages)
        .values({
          id: newId(),
          tenantId: rt.tenantId,
          connectionId: connection.id,
          channel: 'WHATSAPP',
          direction: 'INBOUND',
          kind: p.type === 'text' ? 'TEXT' : 'OTHER',
          externalId: p.id,
          // BSUID primero: la doc indica que wa_id/from puede omitirse.
          contactRef: p.from_user_id ?? p.from ?? 'desconocido',
          body: p.text?.body ?? `[${p.type ?? 'mensaje'}]`,
          status: 'RECEIVED',
          createdAt: rt.now,
          updatedAt: rt.now,
        })
        .onConflictDoNothing();
      return done('PROCESSED', 'Mensaje entrante registrado');
    }
    if (e.topic === 'statuses' && p.id && p.status) {
      const map = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' } as const;
      const status = map[p.status as keyof typeof map] as
        (typeof map)[keyof typeof map] | undefined;
      if (status) {
        await rt.db
          .update(channelMessages)
          .set({ status, updatedAt: rt.now })
          .where(
            and(
              eq(channelMessages.connectionId, connection.id),
              eq(channelMessages.externalId, p.id),
            ),
          );
      }
      return done('PROCESSED', `Estado ${p.status}`);
    }
    return done('IGNORED', `Evento ${e.topic} no utilizado`);
  }

  return done('PROCESSED', `Evento ${e.topic} registrado`);
};

export type { WebhookRequest };
export const webhookChannelOf = (slug: string): ChannelKind | null =>
  (WEBHOOK_CHANNELS as Record<string, ChannelKind>)[slug] ?? null;

import { z } from 'zod';
import { appError, err, ok, type Result } from '@vc/shared';
import { bearer, caps, httpJson, notConfigured, S, U, writesBlocked } from './common';
import { handleMetaWebhook, META_GRAPH_VERSION } from './meta';
import type { AdapterContext, ChannelAdapter, NormalizedWebhookEvent } from './types';

/**
 * WhatsApp Business Cloud API (oficial). Fuente: developers.facebook.com/documentation/
 * business-messaging/whatsapp (send-messages, templates, webhooks, access-tokens,
 * phone-number API), consultado 2026-11-17.
 *
 * Token: de usuario del sistema emitido por el negocio en Meta Business (permisos
 * whatsapp_business_messaging y whatsapp_business_management). No hay renovación por API.
 */
export const WA_GRAPH = 'https://graph.facebook.com';

const PhoneNumber = z.object({
  id: z.string(),
  display_phone_number: z.string().optional(),
  verified_name: z.string().optional(),
  quality_rating: z.string().optional(),
});
const SendResponse = z.object({
  messages: z.array(z.object({ id: z.string() })).min(1),
});

const noListings = (what: string) =>
  Promise.resolve(
    err(
      appError(
        'UNSUPPORTED_OPERATION',
        `${what}: WhatsApp Cloud API no gestiona publicaciones ni pedidos en esta integración`,
      ),
    ),
  );

export const createWhatsAppAdapter = (ctx: AdapterContext): ChannelAdapter => {
  const token = ctx.tokens?.accessToken;
  const phoneId = ctx.tokens?.externalAccountId;

  const fetchPhone = (accessToken: string, id: string) =>
    httpJson(ctx, `${WA_GRAPH}/${META_GRAPH_VERSION}/${encodeURIComponent(id)}`, PhoneNumber, {
      headers: bearer(accessToken),
    });

  return {
    channel: 'WHATSAPP',
    mode: 'LIVE',
    requiredPublishScopes: [],
    capabilities: caps(
      {
        connect: S(
          'Token de usuario del sistema + ID del número, validados con GET /{phone-number-id}',
        ),
        disconnect: { support: 'LOCAL_ONLY', note: 'Se borra el token local' },
        getConnectionStatus: S('GET /{phone-number-id}'),
        handleWebhook: S('Webhooks de Meta con X-Hub-Signature-256 (mensajes y estados)'),
      },
      U(
        'WhatsApp Cloud API se usa para mensajes y atención, no para catálogo, publicaciones ni pedidos',
      ),
    ),

    connect: async (request) => {
      if (request.type !== 'token')
        return err(appError('VALIDATION_ERROR', 'WhatsApp se conecta con token del sistema'));
      const phone = await fetchPhone(request.accessToken, request.accountId);
      if (!phone.ok) return phone;
      return ok({
        type: 'tokens',
        tokens: {
          accessToken: request.accessToken,
          refreshToken: null,
          expiresAt: null,
          scopes: [],
          externalAccountId: phone.value.id,
        },
      });
    },

    disconnect: () => Promise.resolve(ok({ remoteRevoked: false })),

    getConnectionStatus: async () => {
      if (!token || !phoneId)
        return ok({
          status: 'NOT_CONFIGURED',
          detail: 'Número no conectado',
          externalAccountId: null,
          externalAccountName: null,
          expiresAt: null,
        });
      const phone = await fetchPhone(token, phoneId);
      if (!phone.ok)
        return ok({
          status: phone.error.code === 'UNAUTHORIZED' ? 'EXPIRED' : 'ERROR',
          detail: phone.error.message,
          externalAccountId: phoneId,
          externalAccountName: null,
          expiresAt: null,
        });
      return ok({
        status: 'CONNECTED',
        detail: `Número verificado${phone.value.quality_rating ? ` (calidad ${phone.value.quality_rating})` : ''}`,
        externalAccountId: phone.value.id,
        externalAccountName: phone.value.verified_name ?? phone.value.display_phone_number ?? null,
        expiresAt: null,
      });
    },

    refreshTokens: () =>
      Promise.resolve(
        err(appError('UNSUPPORTED_OPERATION', 'El token del sistema no se renueva por API')),
      ),
    getCatalog: () => noListings('Catálogo'),
    createListing: () => noListings('Publicar'),
    updateListing: () => noListings('Actualizar'),
    pauseListing: () => noListings('Pausar'),
    getOrders: () => noListings('Pedidos'),
    getOrderStatus: () => noListings('Pedido'),

    handleWebhook: (request) =>
      handleMetaWebhook(ctx, request, (envelope) => {
        const events: NormalizedWebhookEvent[] = [];
        if (envelope.object !== 'whatsapp_business_account') return events;
        for (const entry of envelope.entry) {
          for (const change of entry.changes ?? []) {
            const value = WaValue.safeParse(change.value ?? {});
            if (!value.success) continue;
            const account = value.data.metadata?.phone_number_id ?? null;
            for (const m of value.data.messages ?? []) {
              events.push({
                dedupeKey: `wa:msg:${m.id}`,
                topic: 'messages',
                resource: m.id,
                externalAccountId: account,
                payload: m,
              });
            }
            for (const s of value.data.statuses ?? []) {
              events.push({
                dedupeKey: `wa:status:${s.id}:${s.status}`,
                topic: 'statuses',
                resource: s.id,
                externalAccountId: account,
                payload: s,
              });
            }
          }
        }
        return events;
      }),
  };
};

const WaValue = z.object({
  metadata: z.object({ phone_number_id: z.string() }).partial().optional(),
  messages: z
    .array(
      z
        .object({
          id: z.string(),
          from: z.string().optional(),
          from_user_id: z.string().optional(),
          timestamp: z.string().optional(),
          type: z.string(),
          text: z.object({ body: z.string() }).optional(),
        })
        .loose(),
    )
    .optional(),
  statuses: z
    .array(
      z
        .object({
          id: z.string(),
          status: z.string(),
          timestamp: z.string().optional(),
          recipient_id: z.string().optional(),
        })
        .loose(),
    )
    .optional(),
});

export type WhatsAppOutbound =
  | { readonly kind: 'text'; readonly to: string; readonly body: string }
  | {
      readonly kind: 'template';
      readonly to: string;
      readonly name: string;
      readonly languageCode: string;
      readonly parameters: readonly string[];
    };

/** Cuerpo documentado de POST /{phone-number-id}/messages. */
export const toWhatsAppPayload = (msg: WhatsAppOutbound) =>
  msg.kind === 'text'
    ? {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: msg.to,
        type: 'text',
        text: { body: msg.body },
      }
    : {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: msg.to,
        type: 'template',
        template: {
          name: msg.name,
          language: { code: msg.languageCode },
          components:
            msg.parameters.length > 0
              ? [
                  {
                    type: 'body',
                    parameters: msg.parameters.map((text) => ({ type: 'text', text })),
                  },
                ]
              : [],
        },
      };

/** Envía un mensaje. Es contacto con clientes: acción comercial (bloqueada por defecto). */
export const sendWhatsAppMessage = async (
  ctx: AdapterContext,
  msg: WhatsAppOutbound,
): Promise<Result<{ wamid: string }>> => {
  if (!ctx.allowWrites) return writesBlocked('Enviar mensaje de WhatsApp');
  const token = ctx.tokens?.accessToken;
  const phoneId = ctx.tokens?.externalAccountId;
  if (!token || !phoneId) return notConfigured('WhatsApp: número no conectado');
  const res = await httpJson(
    ctx,
    `${WA_GRAPH}/${META_GRAPH_VERSION}/${encodeURIComponent(phoneId)}/messages`,
    SendResponse,
    { method: 'POST', headers: bearer(token), json: toWhatsAppPayload(msg) },
  );
  // El wamid solo indica que la API aceptó el pedido; la entrega llega por webhook.
  return res.ok ? ok({ wamid: res.value.messages[0]?.id ?? '' }) : res;
};

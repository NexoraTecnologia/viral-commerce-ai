import { z } from 'zod';
import { appError, err, ok, type ListingDraft, type Result } from '@vc/shared';
import { normalizeMercadoLibreOrderStatus } from './order-status';
import {
  bearer,
  caps,
  centsToDecimal,
  decimalToCents,
  httpJson,
  L,
  notConfigured,
  S,
  U,
  writesBlocked,
} from './common';
import type {
  AdapterContext,
  ChannelAdapter,
  ExternalOrder,
  ListingRef,
  NormalizedWebhookEvent,
  TokenSet,
} from './types';

/**
 * Mercado Libre Argentina (MLA). Fuente: developers.mercadolibre.com.ar
 * (Autenticación y Autorización, Notificaciones, Publica productos, Preguntas y
 * respuestas, Órdenes, Ítems y búsquedas). Consultado 2026-11-17.
 */
export const ML_AUTH_URL = 'https://auth.mercadolibre.com.ar/authorization';
export const ML_API = 'https://api.mercadolibre.com';
/** Scopes que devuelve el token; `write` es necesario para publicar. */
export const ML_PUBLISH_SCOPES = ['write'] as const;

const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  scope: z.string().default(''),
  user_id: z.union([z.number(), z.string()]).transform(String),
  refresh_token: z.string().optional(),
});

const UserMe = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  nickname: z.string().optional(),
});

const ItemSearch = z.object({ results: z.array(z.string()) });
const Item = z.object({
  id: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
  permalink: z.string().optional(),
});
const Order = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  status: z.string(),
  total_amount: z.number().nullable().optional(),
  currency_id: z.string().nullable().optional(),
  date_created: z.string().nullable().optional(),
});
const OrderSearch = z.object({ results: z.array(Order) });

/** Notificación (POST al callback). Mercado Libre NO firma las notificaciones. */
const Notification = z.object({
  _id: z.string().optional(),
  id: z.string().optional(),
  resource: z.string().min(1),
  user_id: z.union([z.number(), z.string()]).transform(String),
  topic: z.string().min(1),
  application_id: z.union([z.number(), z.string()]).transform(String),
  attempts: z.number().int().optional(),
  sent: z.string().optional(),
  received: z.string().optional(),
  actions: z.array(z.string()).optional(),
});

const toTokens = (t: z.output<typeof TokenResponse>, now: Date): TokenSet => ({
  accessToken: t.access_token,
  // El refresh_token es de uso único: se reemplaza en cada renovación.
  refreshToken: t.refresh_token ?? null,
  // Se usa expires_in de la respuesta (la doc menciona 6 h y el ejemplo 10800 s).
  expiresAt: new Date(now.getTime() + t.expires_in * 1000),
  scopes: t.scope.split(/\s+/).filter(Boolean),
  externalAccountId: t.user_id,
});

const toOrder = (o: z.output<typeof Order>): ExternalOrder => ({
  externalOrderId: o.id,
  status: normalizeMercadoLibreOrderStatus(o.status),
  rawStatus: o.status,
  totalCents: typeof o.total_amount === 'number' ? decimalToCents(o.total_amount) : null,
  currency: o.currency_id ?? null,
  placedAt: o.date_created ? new Date(o.date_created) : null,
});

/** Traduce el borrador al cuerpo de POST /items (campos documentados). */
export const toMercadoLibreItem = (draft: ListingDraft) => ({
  title: draft.title,
  category_id: draft.categoryId,
  price: centsToDecimal(draft.priceCents),
  currency_id: draft.currency,
  available_quantity: draft.quantity,
  buying_mode: 'buy_it_now',
  // Sin valores por defecto inventados: tipo de publicación y condición los define el usuario.
  listing_type_id: draft.listingTypeId,
  condition: draft.condition,
  pictures: draft.imageUrls.map((source) => ({ source })),
});

export const createMercadoLibreAdapter = (ctx: AdapterContext): ChannelAdapter => {
  const { clientId, clientSecret } = ctx.credentials;
  const token = ctx.tokens?.accessToken;
  const userId = ctx.tokens?.externalAccountId;

  const requireToken = <T>(): Result<T> | null =>
    token ? null : notConfigured('Mercado Libre: cuenta no conectada');

  const getItem = (id: string) =>
    httpJson(ctx, `${ML_API}/items/${encodeURIComponent(id)}`, Item, {
      headers: bearer(token ?? ''),
    });

  const toRef = (item: z.output<typeof Item>): ListingRef => ({
    externalId: item.id,
    externalUrl: item.permalink ?? null,
    status:
      item.status === 'paused' ? 'PAUSED' : item.status === 'active' ? 'PUBLISHED' : 'PENDING',
  });

  return {
    channel: 'MERCADO_LIBRE',
    mode: 'LIVE',
    requiredPublishScopes: ML_PUBLISH_SCOPES,
    capabilities: caps(
      {
        connect: S('OAuth 2.0 Authorization Code (server side) con PKCE S256 y state'),
        disconnect: L(
          'Se borran los tokens locales. La revocación del permiso la hace el vendedor en Mercado Libre',
        ),
        getConnectionStatus: S('GET /users/me con el access token'),
        getCatalog: S('GET /users/{id}/items/search + GET /items/{id}'),
        createListing: S('POST /items (requiere scope write y categoría)'),
        updateListing: S('PUT /items/{id} (el título solo si sold_quantity = 0)'),
        pauseListing: S('PUT /items/{id} con status "paused"'),
        getOrders: S('GET /orders/search?seller={id}'),
        getOrderStatus: S('GET /orders/{id}'),
        handleWebhook: S(
          'Notificaciones sin firma: se valida application_id y se consulta el recurso',
        ),
      },
      U('No soportado'),
    ),

    connect: async (request) => {
      if (!clientId || !clientSecret)
        return notConfigured('Mercado Libre: faltan ML_APP_ID / ML_CLIENT_SECRET');
      if (request.type === 'authorize') {
        const url = new URL(ML_AUTH_URL);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', request.redirectUri);
        url.searchParams.set('state', request.state);
        if (request.codeChallenge) {
          url.searchParams.set('code_challenge', request.codeChallenge);
          url.searchParams.set('code_challenge_method', 'S256');
        }
        return ok({ type: 'redirect', authorizationUrl: url.toString() });
      }
      if (request.type === 'exchange_code') {
        const form: Record<string, string> = {
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code: request.code,
          redirect_uri: request.redirectUri,
        };
        if (request.codeVerifier) form['code_verifier'] = request.codeVerifier;
        const res = await httpJson(ctx, `${ML_API}/oauth/token`, TokenResponse, {
          method: 'POST',
          form,
        });
        return res.ok ? ok({ type: 'tokens', tokens: toTokens(res.value, ctx.now()) }) : res;
      }
      return err(appError('VALIDATION_ERROR', 'Mercado Libre se conecta por OAuth'));
    },

    disconnect: () => Promise.resolve(ok({ remoteRevoked: false })),

    getConnectionStatus: async () => {
      if (!token) {
        return ok({
          status: 'NOT_CONFIGURED',
          detail: 'Cuenta no conectada',
          externalAccountId: null,
          externalAccountName: null,
          expiresAt: null,
        });
      }
      const expiresAt = ctx.tokens.expiresAt;
      if (expiresAt && expiresAt.getTime() <= ctx.now().getTime()) {
        return ok({
          status: 'EXPIRED',
          detail: 'El access token venció; se requiere renovarlo',
          externalAccountId: userId ?? null,
          externalAccountName: null,
          expiresAt,
        });
      }
      const me = await httpJson(ctx, `${ML_API}/users/me`, UserMe, { headers: bearer(token) });
      if (!me.ok) {
        return ok({
          status: me.error.code === 'UNAUTHORIZED' ? 'EXPIRED' : 'ERROR',
          detail: me.error.message,
          externalAccountId: userId ?? null,
          externalAccountName: null,
          expiresAt,
        });
      }
      return ok({
        status: 'CONNECTED',
        detail: 'Verificado con GET /users/me',
        externalAccountId: me.value.id,
        externalAccountName: me.value.nickname ?? null,
        expiresAt,
      });
    },

    refreshTokens: async () => {
      if (!clientId || !clientSecret)
        return notConfigured('Mercado Libre: faltan credenciales de la app');
      const refresh = ctx.tokens?.refreshToken;
      if (!refresh)
        return notConfigured('Mercado Libre: no hay refresh_token (requiere offline_access)');
      const res = await httpJson(ctx, `${ML_API}/oauth/token`, TokenResponse, {
        method: 'POST',
        form: {
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refresh,
        },
      });
      return res.ok ? ok(toTokens(res.value, ctx.now())) : res;
    },

    getCatalog: async () => {
      const missing = requireToken<never>();
      if (missing) return missing;
      const search = await httpJson(
        ctx,
        `${ML_API}/users/${encodeURIComponent(userId ?? '')}/items/search`,
        ItemSearch,
        { headers: bearer(token ?? '') },
      );
      if (!search.ok) return search;
      const items = [];
      // Workers Free: 50 subrequests por invocación (1 búsqueda + hasta 40 ítems).
      for (const id of search.value.results.slice(0, 40)) {
        const item = await getItem(id);
        if (!item.ok) return item;
        items.push({
          externalId: item.value.id,
          title: item.value.title ?? null,
          status: item.value.status ?? null,
          url: item.value.permalink ?? null,
        });
      }
      return ok(items);
    },

    createListing: async (draft) => {
      if (!ctx.allowWrites) return writesBlocked('Publicar en Mercado Libre');
      const missing = requireToken<never>();
      if (missing) return missing;
      if (!draft.categoryId || !draft.listingTypeId || !draft.condition)
        return err(appError('VALIDATION_ERROR', 'Faltan category_id, listing_type_id o condition'));
      const res = await httpJson(ctx, `${ML_API}/items`, Item, {
        method: 'POST',
        headers: bearer(token ?? ''),
        json: toMercadoLibreItem(draft),
      });
      return res.ok ? ok(toRef(res.value)) : res;
    },

    updateListing: async (externalId, draft) => {
      if (!ctx.allowWrites) return writesBlocked('Actualizar en Mercado Libre');
      const missing = requireToken<never>();
      if (missing) return missing;
      const res = await httpJson(ctx, `${ML_API}/items/${encodeURIComponent(externalId)}`, Item, {
        method: 'PUT',
        headers: bearer(token ?? ''),
        json: {
          price: centsToDecimal(draft.priceCents),
          available_quantity: draft.quantity,
          pictures: draft.imageUrls.map((source) => ({ source })),
        },
      });
      return res.ok ? ok(toRef(res.value)) : res;
    },

    pauseListing: async (externalId) => {
      if (!ctx.allowWrites) return writesBlocked('Pausar en Mercado Libre');
      const missing = requireToken<never>();
      if (missing) return missing;
      const res = await httpJson(ctx, `${ML_API}/items/${encodeURIComponent(externalId)}`, Item, {
        method: 'PUT',
        headers: bearer(token ?? ''),
        json: { status: 'paused' },
      });
      return res.ok ? ok(toRef(res.value)) : res;
    },

    getOrders: async (query) => {
      const missing = requireToken<never>();
      if (missing) return missing;
      const url = new URL(`${ML_API}/orders/search`);
      url.searchParams.set('seller', userId ?? '');
      url.searchParams.set('sort', 'date_desc');
      url.searchParams.set('limit', String(query.limit));
      url.searchParams.set('offset', String(query.offset));
      const res = await httpJson(ctx, url.toString(), OrderSearch, {
        headers: bearer(token ?? ''),
      });
      return res.ok ? ok(res.value.results.map(toOrder)) : res;
    },

    getOrderStatus: async (externalOrderId) => {
      const missing = requireToken<never>();
      if (missing) return missing;
      const res = await httpJson(
        ctx,
        `${ML_API}/orders/${encodeURIComponent(externalOrderId)}`,
        Order,
        { headers: bearer(token ?? '') },
      );
      return res.ok ? ok(toOrder(res.value)) : res;
    },

    handleWebhook: (request) => {
      if (request.method !== 'POST') {
        return Promise.resolve(ok({ type: 'rejected' as const, reason: 'Método no admitido' }));
      }
      let json: unknown;
      try {
        json = JSON.parse(request.rawBody);
      } catch {
        return Promise.resolve(ok({ type: 'rejected' as const, reason: 'JSON inválido' }));
      }
      const parsed = Notification.safeParse(json);
      if (!parsed.success) {
        return Promise.resolve(ok({ type: 'rejected' as const, reason: 'Formato no reconocido' }));
      }
      const n = parsed.data;
      // Sin firma: la autenticidad se acota verificando que sea para NUESTRA app
      // y, al procesar, consultando el recurso con nuestro token (nunca se confía
      // en el contenido de la notificación).
      if (!clientId || n.application_id !== clientId) {
        return Promise.resolve(
          ok({ type: 'rejected' as const, reason: 'application_id no corresponde a esta app' }),
        );
      }
      const event: NormalizedWebhookEvent = {
        dedupeKey: n._id ?? n.id ?? `${n.topic}|${n.resource}|${n.received ?? n.sent ?? ''}`,
        topic: n.topic,
        resource: n.resource,
        externalAccountId: n.user_id,
        payload: { ...n },
      };
      return Promise.resolve(ok({ type: 'events' as const, events: [event] }));
    },
  };
};

/* ---- Preguntas y respuestas (específico de Mercado Libre) ---- */

const Question = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  text: z.string(),
  status: z.string(),
  item_id: z.string().optional(),
  date_created: z.string().optional(),
});
const QuestionSearch = z.object({ questions: z.array(Question) });

export const listMercadoLibreQuestions = async (ctx: AdapterContext) => {
  const token = ctx.tokens?.accessToken;
  if (!token) return notConfigured<never>('Mercado Libre: cuenta no conectada');
  const url = `${ML_API}/questions/search?seller_id=${encodeURIComponent(ctx.tokens.externalAccountId ?? '')}&api_version=4`;
  const res = await httpJson(ctx, url, QuestionSearch, { headers: bearer(token) });
  return res.ok ? ok(res.value.questions) : res;
};

/** POST /answers. Máximo 2000 caracteres. Es contacto con clientes: acción comercial. */
export const answerMercadoLibreQuestion = async (
  ctx: AdapterContext,
  questionId: string,
  text: string,
): Promise<Result<{ questionId: string }>> => {
  if (!ctx.allowWrites) return writesBlocked('Responder pregunta en Mercado Libre');
  const token = ctx.tokens?.accessToken;
  if (!token) return notConfigured('Mercado Libre: cuenta no conectada');
  if (text.length > 2000) return err(appError('VALIDATION_ERROR', 'Máximo 2000 caracteres'));
  const res = await httpJson(ctx, `${ML_API}/answers`, z.unknown(), {
    method: 'POST',
    headers: bearer(token),
    json: { question_id: Number(questionId), text },
  });
  return res.ok ? ok({ questionId }) : res;
};

import { z } from 'zod';
import { appError, err, ok, type Result } from '@vc/shared';
import { caps, httpJson, notConfigured, S, U, writesBlocked } from './common';
import { handleMetaWebhook, META_GRAPH_VERSION } from './meta';
import type { AdapterContext, ChannelAdapter, NormalizedWebhookEvent, TokenSet } from './types';

/**
 * Instagram API con Instagram Login (cuenta profesional: Business o Creator).
 * Fuente: developers.facebook.com/documentation/instagram-platform (content-publishing,
 * business-login, ig-user/media), consultado 2026-11-17.
 */
export const IG_AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
export const IG_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
export const IG_GRAPH = 'https://graph.instagram.com';
export const IG_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];
const DAY_MS = 86_400_000;

const ShortToken = z.object({
  access_token: z.string().min(1),
  user_id: z.union([z.number(), z.string()]).transform(String),
  permissions: z.union([z.string(), z.array(z.string())]).optional(),
});
/** La doc muestra la respuesta envuelta en `data: [...]`; se aceptan ambas formas. */
const ShortTokenResponse = z.union([
  z
    .object({ data: z.array(ShortToken).min(1) })
    .transform((v) => v.data[0] as z.output<typeof ShortToken>),
  ShortToken,
]);
const LongToken = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive(),
});
const MeFields = z.object({
  user_id: z.union([z.number(), z.string()]).transform(String).optional(),
  id: z.string().optional(),
  username: z.string().optional(),
});
const Me = z.union([
  z
    .object({ data: z.array(MeFields).min(1) })
    .transform((v) => v.data[0] as z.output<typeof MeFields>),
  MeFields,
]);
const MediaList = z.object({ data: z.array(z.object({ id: z.string() })) });
const IdResponse = z.object({ id: z.string() });
const ContainerStatus = z.object({ status_code: z.string().optional() });

const permissionsOf = (p: string | string[] | undefined): string[] =>
  Array.isArray(p)
    ? p
    : (p ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);

export const createInstagramAdapter = (ctx: AdapterContext): ChannelAdapter => {
  const { clientId, clientSecret } = ctx.credentials;
  const token = ctx.tokens?.accessToken;
  const igId = ctx.tokens?.externalAccountId;
  const graph = (path: string, params: Record<string, string> = {}) => {
    const url = new URL(`${IG_GRAPH}/${META_GRAPH_VERSION}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', token ?? '');
    return url.toString();
  };

  return {
    channel: 'INSTAGRAM',
    mode: 'LIVE',
    requiredPublishScopes: ['instagram_business_content_publish'],
    capabilities: caps(
      {
        connect: S('OAuth Instagram Login → token corto (1 h) → token largo (60 días)'),
        disconnect: { support: 'LOCAL_ONLY', note: 'Se borran los tokens locales' },
        getConnectionStatus: S('GET /me?fields=user_id,username'),
        getCatalog: S('GET /{ig-id}/media (publicaciones existentes)'),
        createListing: S(
          'Contenedor POST /{ig-id}/media + POST /{ig-id}/media_publish. Solo JPEG en URL pública',
        ),
        updateListing: U('La API no permite editar publicaciones (doc oficial: "not supported")'),
        pauseListing: U('La API no permite ocultar ni borrar publicaciones'),
        getOrders: U('Instagram no expone pedidos ni checkout por API'),
        getOrderStatus: U('Instagram no expone pedidos ni checkout por API'),
        handleWebhook: S('Webhooks de Meta con X-Hub-Signature-256'),
      },
      U('No soportado'),
    ),

    connect: async (request) => {
      if (!clientId || !clientSecret)
        return notConfigured('Instagram: faltan INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET');
      if (request.type === 'authorize') {
        const url = new URL(IG_AUTHORIZE_URL);
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', request.redirectUri);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', IG_SCOPES.join(','));
        url.searchParams.set('state', request.state);
        return ok({ type: 'redirect', authorizationUrl: url.toString() });
      }
      if (request.type !== 'exchange_code')
        return err(appError('VALIDATION_ERROR', 'Instagram se conecta por OAuth'));
      const short = await httpJson(ctx, IG_TOKEN_URL, ShortTokenResponse, {
        method: 'POST',
        form: {
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          redirect_uri: request.redirectUri,
          // La doc indica quitar el sufijo "#_" del code.
          code: request.code.replace(/#_$/, ''),
        },
      });
      if (!short.ok) return short;
      const longUrl = new URL(`${IG_GRAPH}/access_token`);
      longUrl.searchParams.set('grant_type', 'ig_exchange_token');
      longUrl.searchParams.set('client_secret', clientSecret);
      longUrl.searchParams.set('access_token', short.value.access_token);
      const long = await httpJson(ctx, longUrl.toString(), LongToken);
      if (!long.ok) return long;
      const now = ctx.now();
      const tokens: TokenSet = {
        accessToken: long.value.access_token,
        refreshToken: null,
        expiresAt: new Date(now.getTime() + long.value.expires_in * 1000),
        scopes: permissionsOf(short.value.permissions),
        externalAccountId: short.value.user_id,
      };
      return ok({ type: 'tokens', tokens });
    },

    disconnect: () => Promise.resolve(ok({ remoteRevoked: false })),

    getConnectionStatus: async () => {
      if (!token)
        return ok({
          status: 'NOT_CONFIGURED',
          detail: 'Cuenta no conectada',
          externalAccountId: null,
          externalAccountName: null,
          expiresAt: null,
        });
      const expiresAt = ctx.tokens.expiresAt;
      if (expiresAt && expiresAt.getTime() <= ctx.now().getTime()) {
        return ok({
          status: 'EXPIRED',
          detail: 'El token largo venció (60 días sin renovar): hay que volver a autorizar',
          externalAccountId: igId ?? null,
          externalAccountName: null,
          expiresAt,
        });
      }
      const me = await httpJson(ctx, graph('me', { fields: 'user_id,username' }), Me);
      if (!me.ok)
        return ok({
          status: me.error.code === 'UNAUTHORIZED' ? 'EXPIRED' : 'ERROR',
          detail: me.error.message,
          externalAccountId: igId ?? null,
          externalAccountName: null,
          expiresAt,
        });
      return ok({
        status: 'CONNECTED',
        detail: 'Verificado con GET /me',
        externalAccountId: me.value.user_id ?? igId ?? null,
        externalAccountName: me.value.username ?? null,
        expiresAt,
      });
    },

    /** ig_refresh_token: el token debe tener ≥ 24 h y no estar vencido. */
    refreshTokens: async (): Promise<Result<TokenSet>> => {
      if (!token) return notConfigured('Instagram: cuenta no conectada');
      const exp = ctx.tokens.expiresAt;
      const now = ctx.now();
      if (exp && exp.getTime() <= now.getTime())
        return err(appError('CONFLICT', 'Token vencido: no se puede renovar, hay que reautorizar'));
      if (exp && exp.getTime() - now.getTime() > 59 * DAY_MS)
        return err(appError('CONFLICT', 'El token debe tener al menos 24 h para renovarse'));
      const url = new URL(`${IG_GRAPH}/refresh_access_token`);
      url.searchParams.set('grant_type', 'ig_refresh_token');
      url.searchParams.set('access_token', token);
      const res = await httpJson(ctx, url.toString(), LongToken);
      if (!res.ok) return res;
      return ok({
        ...ctx.tokens,
        accessToken: res.value.access_token,
        expiresAt: new Date(now.getTime() + res.value.expires_in * 1000),
      });
    },

    getCatalog: async () => {
      if (!token || !igId) return notConfigured('Instagram: cuenta no conectada');
      const res = await httpJson(ctx, graph(`${igId}/media`), MediaList);
      return res.ok
        ? ok(
            res.value.data.map((m) => ({
              externalId: m.id,
              title: null,
              status: 'PUBLISHED',
              url: null,
            })),
          )
        : res;
    },

    createListing: async (draft) => {
      if (!ctx.allowWrites) return writesBlocked('Publicar en Instagram');
      if (!token || !igId) return notConfigured('Instagram: cuenta no conectada');
      const [image, ...rest] = draft.imageUrls;
      if (!image) return err(appError('VALIDATION_ERROR', 'Instagram requiere una imagen'));
      if (rest.length > 0)
        return err(appError('UNSUPPORTED_OPERATION', 'Carruseles todavía no implementados'));
      const container = await httpJson(ctx, graph(`${igId}/media`), IdResponse, {
        method: 'POST',
        form: { image_url: image, caption: draft.caption ?? '' },
      });
      if (!container.ok) return container;
      const status = await httpJson(
        ctx,
        graph(container.value.id, { fields: 'status_code' }),
        ContainerStatus,
      );
      if (!status.ok) return status;
      if (status.value.status_code !== 'FINISHED') {
        return err(
          appError('UPSTREAM_ERROR', `Contenedor en estado ${status.value.status_code ?? '?'}`, {
            containerId: container.value.id,
            retryable: status.value.status_code === 'IN_PROGRESS',
          }),
        );
      }
      const published = await httpJson(ctx, graph(`${igId}/media_publish`), IdResponse, {
        method: 'POST',
        form: { creation_id: container.value.id },
      });
      return published.ok
        ? ok({ externalId: published.value.id, externalUrl: null, status: 'PUBLISHED' })
        : published;
    },

    updateListing: () =>
      Promise.resolve(
        err(appError('UNSUPPORTED_OPERATION', 'Instagram no permite editar publicaciones por API')),
      ),
    pauseListing: () =>
      Promise.resolve(
        err(appError('UNSUPPORTED_OPERATION', 'Instagram no permite pausar publicaciones por API')),
      ),
    getOrders: () =>
      Promise.resolve(
        err(appError('UNSUPPORTED_OPERATION', 'Instagram no expone pedidos por API')),
      ),
    getOrderStatus: () =>
      Promise.resolve(
        err(appError('UNSUPPORTED_OPERATION', 'Instagram no expone pedidos por API')),
      ),

    handleWebhook: (request) =>
      handleMetaWebhook(ctx, request, (envelope, bodyHash) => {
        const events: NormalizedWebhookEvent[] = [];
        envelope.entry.forEach((entry, i) => {
          for (const [j, change] of (entry.changes ?? []).entries()) {
            events.push({
              dedupeKey: `${bodyHash}:${i}:c${j}`,
              topic: change.field,
              resource: null,
              externalAccountId: entry.id ?? null,
              payload: { object: envelope.object, ...(change.value ?? {}) },
            });
          }
          for (const [j, msg] of (entry.messaging ?? []).entries()) {
            events.push({
              dedupeKey: `${bodyHash}:${i}:m${j}`,
              topic: 'messages',
              resource: null,
              externalAccountId: entry.id ?? null,
              payload: { object: envelope.object, ...msg },
            });
          }
        });
        return events;
      }),
  };
};

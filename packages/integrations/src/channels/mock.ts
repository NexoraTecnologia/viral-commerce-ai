import { z } from 'zod';
import { appError, err, ok, type ChannelKind, type Result } from '@vc/shared';
import { sha256Hex } from './common';
import type {
  CatalogItem,
  ChannelAdapter,
  ExternalOrder,
  ListingRef,
  NormalizedWebhookEvent,
} from './types';

/**
 * Modo MOCK: simula un canal SIN red, SIN credenciales y SIN efectos externos.
 *
 * - Respeta las capacidades del adaptador real: lo que la API oficial no ofrece
 *   también falla en MOCK (no se simulan capacidades inexistentes).
 * - Los IDs externos empiezan con `mock-` y nunca se confunden con reales.
 * - No trae pedidos ni datos financieros inventados: solo los `fixtures` que pase
 *   explícitamente quien lo usa (p. ej. un test).
 */
export interface MockFixtures {
  readonly catalog?: readonly CatalogItem[];
  readonly orders?: readonly ExternalOrder[];
}

const MockWebhook = z.object({
  topic: z.string().min(1),
  resource: z.string().nullable().default(null),
  externalAccountId: z.string().nullable().default(null),
  id: z.string().optional(),
});

export const MOCK_ACCOUNT_ID = 'mock-account';

export const createMockAdapter = (
  real: ChannelAdapter,
  fixtures: MockFixtures = {},
): ChannelAdapter & { readonly listings: ReadonlyMap<string, ListingRef> } => {
  const listings = new Map<string, ListingRef>();
  const channel: ChannelKind = real.channel;
  const supports = (op: keyof typeof real.capabilities) =>
    real.capabilities[op].support !== 'UNSUPPORTED';
  const unsupported = <T>(op: keyof typeof real.capabilities): Promise<Result<T>> =>
    Promise.resolve(
      err(
        appError(
          'UNSUPPORTED_OPERATION',
          `[MOCK] ${channel} no soporta ${op}: ${real.capabilities[op].note}`,
        ),
      ),
    );

  return {
    channel,
    mode: 'MOCK',
    capabilities: real.capabilities,
    requiredPublishScopes: real.requiredPublishScopes,
    listings,

    connect: () =>
      Promise.resolve(
        ok({
          type: 'tokens' as const,
          tokens: {
            accessToken: 'mock-token-sin-valor',
            refreshToken: null,
            expiresAt: null,
            scopes: [...real.requiredPublishScopes],
            externalAccountId: MOCK_ACCOUNT_ID,
          },
        }),
      ),
    disconnect: () => Promise.resolve(ok({ remoteRevoked: false })),
    getConnectionStatus: () =>
      Promise.resolve(
        ok({
          status: 'CONNECTED' as const,
          detail: 'MOCK: simulación local, sin conexión real con el canal',
          externalAccountId: MOCK_ACCOUNT_ID,
          externalAccountName: 'Cuenta simulada',
          expiresAt: null,
        }),
      ),
    refreshTokens: () =>
      Promise.resolve(err(appError('UNSUPPORTED_OPERATION', '[MOCK] sin tokens reales'))),

    getCatalog: () =>
      supports('getCatalog')
        ? Promise.resolve(
            ok([
              ...(fixtures.catalog ?? []),
              ...[...listings.values()].map((l) => ({
                externalId: l.externalId,
                title: null,
                status: l.status,
                url: null,
              })),
            ]),
          )
        : unsupported('getCatalog'),

    createListing: async (_draft, idempotencyKey) => {
      if (!supports('createListing')) return unsupported('createListing');
      const externalId = `mock-${(await sha256Hex(`${channel}:${idempotencyKey}`)).slice(0, 16)}`;
      const ref: ListingRef = listings.get(externalId) ?? {
        externalId,
        externalUrl: null,
        status: 'PUBLISHED',
      };
      listings.set(externalId, ref);
      return ok(ref);
    },
    updateListing: (externalId) => {
      if (!supports('updateListing')) return unsupported('updateListing');
      const current = listings.get(externalId);
      if (!current && !externalId.startsWith('mock-'))
        return Promise.resolve(err(appError('NOT_FOUND', '[MOCK] publicación inexistente')));
      const ref: ListingRef = current ?? { externalId, externalUrl: null, status: 'PUBLISHED' };
      listings.set(externalId, ref);
      return Promise.resolve(ok(ref));
    },
    pauseListing: (externalId) => {
      if (!supports('pauseListing')) return unsupported('pauseListing');
      const ref: ListingRef = { externalId, externalUrl: null, status: 'PAUSED' };
      listings.set(externalId, ref);
      return Promise.resolve(ok(ref));
    },
    getOrders: () =>
      supports('getOrders') ? Promise.resolve(ok(fixtures.orders ?? [])) : unsupported('getOrders'),
    getOrderStatus: (id) => {
      if (!supports('getOrderStatus')) return unsupported('getOrderStatus');
      const order = fixtures.orders?.find((o) => o.externalOrderId === id);
      return Promise.resolve(
        order ? ok(order) : err(appError('NOT_FOUND', '[MOCK] pedido inexistente')),
      );
    },

    handleWebhook: async (request) => {
      if (!supports('handleWebhook')) return unsupported('handleWebhook');
      let json: unknown;
      try {
        json = JSON.parse(request.rawBody);
      } catch {
        return ok({ type: 'rejected' as const, reason: 'JSON inválido' });
      }
      const parsed = MockWebhook.safeParse(json);
      if (!parsed.success)
        return ok({ type: 'rejected' as const, reason: 'Formato MOCK inválido' });
      const event: NormalizedWebhookEvent = {
        dedupeKey: parsed.data.id ?? `mock:${await sha256Hex(request.rawBody)}`,
        topic: parsed.data.topic,
        resource: parsed.data.resource,
        externalAccountId: parsed.data.externalAccountId,
        payload: { mock: true, ...parsed.data },
      };
      return ok({ type: 'events' as const, events: [event] });
    },
  };
};

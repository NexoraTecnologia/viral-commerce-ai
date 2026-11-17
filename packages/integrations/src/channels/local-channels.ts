import { appError, err, ok, type Result } from '@vc/shared';
import { caps, L, notConfigured, U, writesBlocked } from './common';
import type { AdapterContext, CatalogItem, ChannelAdapter } from './types';

/* ================================ Tienda propia ================================ */

/**
 * Tienda propia: catálogo y páginas de producto servidos por nuestro Worker.
 * El CHECKOUT está separado (ver `CheckoutProvider`): sin pasarela configurada no
 * hay pedidos ni cobros, y no se simulan pagos.
 */
export const createOwnStoreAdapter = (
  ctx: AdapterContext,
  catalog: () => Promise<readonly CatalogItem[]>,
): ChannelAdapter => ({
  channel: 'OWN_STORE',
  mode: 'LIVE',
  requiredPublishScopes: [],
  capabilities: caps(
    {
      connect: L('No requiere conexión externa'),
      disconnect: L('Deshabilita la tienda'),
      getConnectionStatus: L('Disponible siempre; checkout según pasarela'),
      getCatalog: L('Publicaciones visibles en la tienda'),
      createListing: L('Hace visible el producto en la tienda (acción comercial)'),
      updateListing: L('Actualiza la página de producto'),
      pauseListing: L('Oculta el producto de la tienda'),
      getOrders: U('Requiere una pasarela de checkout configurada'),
      getOrderStatus: U('Requiere una pasarela de checkout configurada'),
      handleWebhook: U('Los webhooks de pago los atiende el CheckoutProvider'),
    },
    U('No soportado'),
  ),
  connect: () =>
    Promise.resolve(err(appError('VALIDATION_ERROR', 'La tienda propia no se conecta'))),
  disconnect: () => Promise.resolve(ok({ remoteRevoked: false })),
  getConnectionStatus: () =>
    Promise.resolve(
      ok({
        status: 'CONNECTED' as const,
        detail: 'Tienda propia servida por la API. Checkout: no configurado',
        externalAccountId: null,
        externalAccountName: null,
        expiresAt: null,
      }),
    ),
  refreshTokens: () =>
    Promise.resolve(err(appError('UNSUPPORTED_OPERATION', 'La tienda propia no usa tokens'))),
  getCatalog: async () => ok(await catalog()),
  createListing: (_draft, key) =>
    Promise.resolve(
      ctx.allowWrites
        ? ok({ externalId: `store:${key}`, externalUrl: null, status: 'PUBLISHED' as const })
        : writesBlocked('Publicar en la tienda propia'),
    ),
  updateListing: (externalId) =>
    Promise.resolve(
      ctx.allowWrites
        ? ok({ externalId, externalUrl: null, status: 'PUBLISHED' as const })
        : writesBlocked('Actualizar en la tienda propia'),
    ),
  pauseListing: (externalId) =>
    Promise.resolve(ok({ externalId, externalUrl: null, status: 'PAUSED' as const })),
  getOrders: () => Promise.resolve(notConfigured('Tienda propia: checkout no configurado')),
  getOrderStatus: () => Promise.resolve(notConfigured('Tienda propia: checkout no configurado')),
  handleWebhook: () =>
    Promise.resolve(err(appError('UNSUPPORTED_OPERATION', 'Sin pasarela de pago configurada'))),
});

/* ================================== Checkout ================================== */

export interface CheckoutSession {
  readonly redirectUrl: string;
  readonly externalSessionId: string;
}

/** Pasarela de pago, separada de la lógica comercial. No hay ninguna configurada. */
export interface CheckoutProvider {
  readonly id: string;
  createSession(input: {
    readonly listingId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly idempotencyKey: string;
  }): Promise<Result<CheckoutSession>>;
}

export const notConfiguredCheckout: CheckoutProvider = {
  id: 'none',
  createSession: () =>
    Promise.resolve(
      notConfigured(
        'Checkout no configurado: falta especificar e integrar una pasarela de pago. No se simulan pagos.',
      ),
    ),
};

/* ================================== Afiliados ================================== */

/**
 * Programas de afiliados. Ninguna red está especificada todavía, así que las
 * operaciones EXTERNAS quedan NOT_CONFIGURED. La gestión de redes, productos,
 * enlaces, clics, conversiones y comisiones es local (ver módulo de afiliados).
 */
export const createAffiliateAdapter = (_ctx: AdapterContext): ChannelAdapter => {
  const nc = <T>(): Promise<Result<T>> =>
    Promise.resolve(
      notConfigured('Red de afiliados sin conector: no hay una API de red especificada'),
    );
  return {
    channel: 'AFFILIATE',
    mode: 'LIVE',
    requiredPublishScopes: [],
    capabilities: caps(
      {
        createListing: L('Se registra un enlace de seguimiento emitido por la red'),
        pauseListing: L('Desactiva el enlace local'),
        getOrders: L('Conversiones registradas con fuente (reporte de la red)'),
      },
      U('Requiere el conector de una red de afiliados específica'),
    ),
    connect: nc,
    disconnect: () => Promise.resolve(ok({ remoteRevoked: false })),
    getConnectionStatus: () =>
      Promise.resolve(
        ok({
          status: 'NOT_CONFIGURED' as const,
          detail: 'Sin conector de red: gestión local de enlaces y conversiones',
          externalAccountId: null,
          externalAccountName: null,
          expiresAt: null,
        }),
      ),
    refreshTokens: nc,
    getCatalog: nc,
    createListing: nc,
    updateListing: nc,
    pauseListing: nc,
    getOrders: nc,
    getOrderStatus: nc,
    handleWebhook: nc,
  };
};

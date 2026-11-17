import type { ChannelKind, ConnectionMode } from '@vc/shared';
import { createInstagramAdapter } from './instagram';
import { createAffiliateAdapter, createOwnStoreAdapter } from './local-channels';
import { createMercadoLibreAdapter } from './mercadolibre';
import { createMockAdapter, type MockFixtures } from './mock';
import type { AdapterContext, CatalogItem, ChannelAdapter } from './types';
import { createWhatsAppAdapter } from './whatsapp';

export * from './types';
export * from './common';
export * from './meta';
export * from './mercadolibre';
export * from './instagram';
export * from './whatsapp';
export * from './local-channels';
export * from './mock';
export * from './order-status';

export interface AdapterOptions {
  readonly storeCatalog?: () => Promise<readonly CatalogItem[]>;
  readonly mockFixtures?: MockFixtures;
}

/** Crea el adaptador de un canal. MOCK envuelve al real para heredar sus capacidades. */
export const createChannelAdapter = (
  channel: ChannelKind,
  mode: ConnectionMode,
  ctx: AdapterContext,
  options: AdapterOptions = {},
): ChannelAdapter => {
  const real = ((): ChannelAdapter => {
    switch (channel) {
      case 'MERCADO_LIBRE':
        return createMercadoLibreAdapter(ctx);
      case 'INSTAGRAM':
        return createInstagramAdapter(ctx);
      case 'WHATSAPP':
        return createWhatsAppAdapter(ctx);
      case 'OWN_STORE':
        return createOwnStoreAdapter(ctx, options.storeCatalog ?? (() => Promise.resolve([])));
      case 'AFFILIATE':
        return createAffiliateAdapter(ctx);
    }
  })();
  return mode === 'MOCK' ? createMockAdapter(real, options.mockFixtures) : real;
};

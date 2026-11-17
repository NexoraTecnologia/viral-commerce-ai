import { describe, expect, it } from 'vitest';
import { ok } from '@vc/shared';
import { createDiscoveryAdapters, type DiscoveryAdapter } from './discovery';

describe('adaptadores de descubrimiento', () => {
  it('las fuentes sin conector quedan NOT_CONFIGURED y no devuelven datos', async () => {
    const adapters = createDiscoveryAdapters();
    for (const kind of [
      'GOOGLE_TRENDS',
      'PUBLIC_SOURCE',
      'COMMERCIAL_API',
      'SUPPLIER_CATALOG',
    ] as const) {
      expect(adapters[kind].status().status).toBe('NOT_CONFIGURED');
      const r = await adapters[kind].fetchSignals({ tenantId: 't' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INTEGRATION_NOT_CONFIGURED');
    }
    expect(adapters.MANUAL.status().status).toBe('CONFIGURED');
  });

  it('un adaptador conectado reemplaza al no configurado (intercambiable)', async () => {
    const fake: DiscoveryAdapter = {
      kind: 'PUBLIC_SOURCE',
      status: () => ({ status: 'CONFIGURED', detail: 'conector de prueba' }),
      fetchSignals: () => Promise.resolve(ok([])),
    };
    const adapters = createDiscoveryAdapters({ PUBLIC_SOURCE: fake });
    expect(adapters.PUBLIC_SOURCE.status().status).toBe('CONFIGURED');
    expect((await adapters.PUBLIC_SOURCE.fetchSignals({ tenantId: 't' })).ok).toBe(true);
    expect(adapters.GOOGLE_TRENDS.status().status).toBe('NOT_CONFIGURED');
  });
});

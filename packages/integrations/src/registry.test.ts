import { describe, expect, it } from 'vitest';
import { ok } from '@vc/shared';
import { ProviderRegistry, type SupplierProvider } from './index';

/** Doble de prueba: NO es una integración real. */
const fakeSupplier: SupplierProvider = {
  descriptor: { id: 'test-supplier', kind: 'supplier', displayName: 'Proveedor de prueba' },
  searchProducts: () => Promise.resolve(ok([])),
};

describe('ProviderRegistry', () => {
  it('arranca vacío y reporta integraciones no configuradas', () => {
    const registry = new ProviderRegistry<SupplierProvider>();
    expect(registry.list()).toEqual([]);
    const r = registry.get('mercadolibre');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INTEGRATION_NOT_CONFIGURED');
  });

  it('registra y rechaza duplicados', () => {
    const registry = new ProviderRegistry<SupplierProvider>();
    registry.register(fakeSupplier);
    expect(registry.get('test-supplier').ok).toBe(true);
    expect(() => {
      registry.register(fakeSupplier);
    }).toThrow();
  });
});

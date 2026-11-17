import { appError, err, ok, type Result } from '@vc/shared';
import type { ProviderDescriptor } from './contracts';

/**
 * Registro en memoria de proveedores disponibles. Arranca VACÍO a propósito:
 * no hay integraciones reales configuradas en esta etapa.
 */
export class ProviderRegistry<P extends { readonly descriptor: ProviderDescriptor }> {
  readonly #providers = new Map<string, P>();

  register(provider: P): void {
    const { id } = provider.descriptor;
    if (this.#providers.has(id)) {
      throw new Error(`Proveedor duplicado: ${id}`);
    }
    this.#providers.set(id, provider);
  }

  get(id: string): Result<P> {
    const provider = this.#providers.get(id);
    return provider
      ? ok(provider)
      : err(appError('INTEGRATION_NOT_CONFIGURED', `Integración "${id}" no configurada`));
  }

  list(): readonly ProviderDescriptor[] {
    return [...this.#providers.values()].map((p) => p.descriptor);
  }
}

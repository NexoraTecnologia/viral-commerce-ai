import { z } from 'zod';
import { MoneySchema, type Result } from '@vc/shared';

/**
 * CONTRATOS de integración. Este paquete NO contiene integraciones reales todavía:
 * cada proveedor concreto (marketplace, proveedor de dropshipping, red de
 * afiliados, pasarela de pago) se implementará en su propio módulo cuando esté
 * especificado, con credenciales reales provistas por el usuario vía secrets.
 */

export const ProviderKindSchema = z.enum(['supplier', 'sales_channel', 'affiliate_network']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/** Producto tal como lo expone un proveedor externo, normalizado. */
export const ExternalProductSchema = z.object({
  externalId: z.string().min(1),
  title: z.string().min(1),
  cost: MoneySchema,
  stockAvailable: z.boolean(),
  sourceUrl: z.url().optional(),
});
export type ExternalProduct = z.infer<typeof ExternalProductSchema>;

export interface ProviderDescriptor {
  /** Identificador estable, p. ej. "mercadolibre". */
  readonly id: string;
  readonly kind: ProviderKind;
  readonly displayName: string;
}

/** Proveedor de catálogo sin inventario propio (dropshipping). */
export interface SupplierProvider {
  readonly descriptor: ProviderDescriptor;
  /** Solo lectura: no debe tener efectos comerciales. */
  searchProducts(query: string): Promise<Result<readonly ExternalProduct[]>>;
}

/** Red de afiliados: genera enlaces de seguimiento. */
export interface AffiliateProvider {
  readonly descriptor: ProviderDescriptor;
  buildTrackingLink(productUrl: string): Promise<Result<string>>;
}

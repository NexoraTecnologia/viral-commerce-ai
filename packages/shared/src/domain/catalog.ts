import { z } from 'zod';
import { CurrencySchema } from '../money';
import { BpsSchema, CentsSchema, DataSourceSchema, IsoDateTimeSchema } from './common';

export const StockStatusSchema = z.enum(['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'UNKNOWN']);
export type StockStatus = z.infer<typeof StockStatusSchema>;

export const ProductStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

/* ---------- Catálogo del proveedor ---------- */

export const CreateSupplierProductRequestSchema = z.object({
  supplierId: z.uuid(),
  supplierSku: z.string().trim().min(1).max(100),
  title: z.string().trim().min(2).max(300),
  wholesalePriceCents: CentsSchema,
  currency: CurrencySchema,
  /** Momento en que se observó/confirmó el precio. Default: ahora. */
  priceUpdatedAt: IsoDateTimeSchema.optional(),
  priceSource: DataSourceSchema,
  minOrderQty: z.number().int().min(1).max(100_000).default(1),
  productId: z.uuid().optional(),
});
export type CreateSupplierProductRequest = z.infer<typeof CreateSupplierProductRequestSchema>;

export const UpdateSupplierPriceRequestSchema = z.object({
  wholesalePriceCents: CentsSchema,
  priceUpdatedAt: IsoDateTimeSchema.optional(),
  priceSource: DataSourceSchema,
});
export type UpdateSupplierPriceRequest = z.infer<typeof UpdateSupplierPriceRequestSchema>;

export const LinkSupplierProductRequestSchema = z.object({ productId: z.uuid().nullable() });

export const RecordInventoryRequestSchema = z
  .object({
    stockStatus: StockStatusSchema,
    quantity: z.number().int().min(0).max(10_000_000).optional(),
    checkedAt: IsoDateTimeSchema.optional(),
    source: DataSourceSchema,
  })
  .refine((v) => !(v.stockStatus === 'UNKNOWN' && v.quantity !== undefined), {
    message: 'Un stock UNKNOWN no puede informar cantidad',
  })
  .refine((v) => !(v.stockStatus === 'OUT_OF_STOCK' && (v.quantity ?? 0) > 0), {
    message: 'OUT_OF_STOCK no puede tener cantidad positiva',
  });
export type RecordInventoryRequest = z.infer<typeof RecordInventoryRequestSchema>;

export const InventorySnapshotDtoSchema = z.object({
  id: z.uuid(),
  stockStatus: StockStatusSchema,
  quantity: z.number().nullable(),
  checkedAt: IsoDateTimeSchema,
  source: DataSourceSchema,
});
export type InventorySnapshotDto = z.infer<typeof InventorySnapshotDtoSchema>;

export const SupplierProductDtoSchema = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  supplierName: z.string(),
  supplierStatus: z.string(),
  productId: z.uuid().nullable(),
  supplierSku: z.string(),
  title: z.string(),
  wholesalePriceCents: z.number().int(),
  currency: CurrencySchema,
  priceUpdatedAt: IsoDateTimeSchema,
  priceSource: DataSourceSchema,
  minOrderQty: z.number().int(),
  latestInventory: InventorySnapshotDtoSchema.nullable(),
});
export type SupplierProductDto = z.infer<typeof SupplierProductDtoSchema>;

/* ---------- Productos propios (lo que se vende) ---------- */

export const CreateProductRequestSchema = z.object({
  title: z.string().trim().min(2).max(300),
  description: z.string().trim().max(5000).optional(),
  category: z.string().trim().max(100).optional(),
  salePriceCents: CentsSchema.refine((v) => v > 0, 'El precio de venta debe ser mayor a 0'),
  currency: CurrencySchema,
});
export type CreateProductRequest = z.infer<typeof CreateProductRequestSchema>;

export const UpdateProductRequestSchema = CreateProductRequestSchema.partial().extend({
  status: ProductStatusSchema.optional(),
});
export type UpdateProductRequest = z.infer<typeof UpdateProductRequestSchema>;

export const ProductDtoSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  salePriceCents: z.number().int(),
  currency: CurrencySchema,
  status: ProductStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ProductDto = z.infer<typeof ProductDtoSchema>;

/* ---------- Componentes de costo ---------- */

export const CostComponentKindSchema = z.enum([
  'SHIPPING',
  'CHANNEL_COMMISSION',
  'PAYMENT_PROCESSING',
  'TAX',
  'WITHHOLDING',
  'RETURN_RESERVE',
  'OTHER',
]);
export type CostComponentKind = z.infer<typeof CostComponentKindSchema>;

/**
 * Un componente de costo es un monto fijo, un porcentaje sobre el precio de
 * venta, o ambos (p. ej. pasarela: 4,99 % + $10).
 */
export const CostComponentSchema = z
  .object({
    kind: CostComponentKindSchema,
    name: z.string().trim().min(1).max(120),
    fixedCents: CentsSchema.optional(),
    rateBps: BpsSchema.optional(),
  })
  .refine((c) => c.fixedCents !== undefined || c.rateBps !== undefined, {
    message: 'Indicar monto fijo, porcentaje o ambos',
  });
export type CostComponent = z.infer<typeof CostComponentSchema>;

export const ProductCostDtoSchema = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  kind: CostComponentKindSchema,
  name: z.string(),
  fixedCents: z.number().int().nullable(),
  rateBps: z.number().int().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type ProductCostDto = z.infer<typeof ProductCostDtoSchema>;

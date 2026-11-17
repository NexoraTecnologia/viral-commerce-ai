import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { epochMsDefault, timestamps } from '../columns';
import { tenants } from '../schema';
import { suppliers } from './suppliers';

const CURRENCY = ['ARS', 'USD'] as const;
const DATA_SOURCE = ['MANUAL', 'SUPPLIER_REPORT', 'INTEGRATION'] as const;

/** Productos propios: lo que se vende al comprador final. */
export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    category: text('category'),
    salePriceCents: integer('sale_price_cents').notNull(),
    currency: text('currency', { enum: CURRENCY }).notNull(),
    status: text('status', { enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'] })
      .notNull()
      .default('DRAFT'),
    ...timestamps,
  },
  (t) => [index('products_tenant_status_idx').on(t.tenantId, t.status)],
);

/** Catálogo del proveedor con su precio mayorista. */
export const supplierProducts = sqliteTable(
  'supplier_products',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    supplierId: text('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    supplierSku: text('supplier_sku').notNull(),
    title: text('title').notNull(),
    wholesalePriceCents: integer('wholesale_price_cents').notNull(),
    currency: text('currency', { enum: CURRENCY }).notNull(),
    priceUpdatedAt: integer('price_updated_at', { mode: 'timestamp_ms' }).notNull(),
    priceSource: text('price_source', { enum: DATA_SOURCE }).notNull(),
    minOrderQty: integer('min_order_qty').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('supplier_products_supplier_sku_uq').on(t.supplierId, t.supplierSku),
    index('supplier_products_tenant_product_idx').on(t.tenantId, t.productId),
  ],
);

/** Controles de stock (histórico; el vigente es el de `checked_at` más reciente). */
export const supplierInventory = sqliteTable(
  'supplier_inventory',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    supplierProductId: text('supplier_product_id')
      .notNull()
      .references(() => supplierProducts.id, { onDelete: 'cascade' }),
    stockStatus: text('stock_status', {
      enum: ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'UNKNOWN'],
    }).notNull(),
    quantity: integer('quantity'),
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' }).notNull(),
    source: text('source', { enum: DATA_SOURCE }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(epochMsDefault),
  },
  (t) => [index('supplier_inventory_product_checked_idx').on(t.supplierProductId, t.checkedAt)],
);

/** Componentes de costo configurados por producto (envío, comisiones, impuestos, etc.). */
export const productCosts = sqliteTable(
  'product_costs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: [
        'SHIPPING',
        'CHANNEL_COMMISSION',
        'PAYMENT_PROCESSING',
        'TAX',
        'WITHHOLDING',
        'RETURN_RESERVE',
        'OTHER',
      ],
    }).notNull(),
    name: text('name').notNull(),
    fixedCents: integer('fixed_cents'),
    rateBps: integer('rate_bps'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(epochMsDefault),
  },
  (t) => [index('product_costs_product_idx').on(t.productId)],
);

export type ProductRow = typeof products.$inferSelect;
export type SupplierProductRow = typeof supplierProducts.$inferSelect;
export type SupplierInventoryRow = typeof supplierInventory.$inferSelect;
export type ProductCostRow = typeof productCosts.$inferSelect;

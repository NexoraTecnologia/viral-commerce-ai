import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ProfitBreakdown, ViabilityIssue } from '@vc/shared';
import { epochMsDefault } from '../columns';
import { tenants } from '../schema';
import { products, supplierProducts } from './catalog';

/**
 * Resultado de cada cálculo de rentabilidad (append-only). Guarda una foto de
 * los datos usados (`input_snapshot`) para poder auditar decisiones pasadas.
 */
export const profitCalculations = sqliteTable(
  'profit_calculations',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    supplierProductId: text('supplier_product_id')
      .notNull()
      .references(() => supplierProducts.id, { onDelete: 'cascade' }),
    currency: text('currency', { enum: ['ARS', 'USD'] }).notNull(),
    status: text('status', {
      enum: ['PROFITABLE', 'BELOW_MIN_MARGIN', 'NEGATIVE_MARGIN', 'BLOCKED'],
    }).notNull(),
    issues: text('issues', { mode: 'json' }).$type<ViabilityIssue[]>().notNull(),
    salePriceCents: integer('sale_price_cents').notNull(),
    totalCostsCents: integer('total_costs_cents'),
    netProfitCents: integer('net_profit_cents'),
    marginBps: integer('margin_bps'),
    minMarginBps: integer('min_margin_bps').notNull(),
    breakdown: text('breakdown', { mode: 'json' }).$type<ProfitBreakdown>(),
    inputSnapshot: text('input_snapshot', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    calculatedAt: integer('calculated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(epochMsDefault),
  },
  (t) => [
    index('profit_calculations_tenant_calc_idx').on(t.tenantId, t.calculatedAt),
    index('profit_calculations_product_idx').on(t.productId, t.calculatedAt),
  ],
);

export type ProfitCalculationRow = typeof profitCalculations.$inferSelect;

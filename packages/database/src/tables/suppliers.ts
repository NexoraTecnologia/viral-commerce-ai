import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { PaymentMethod, SupplierContact } from '@vc/shared';
import { epochMsDefault, timestamps } from '../columns';
import { tenants } from '../schema';

const SUPPLIER_STATUS = [
  'UNVERIFIED',
  'UNDER_REVIEW',
  'VERIFIED',
  'SUSPENDED',
  'REJECTED',
] as const;

/** Proveedores que despachan directo al comprador (sin inventario propio). */
export const suppliers = sqliteTable(
  'suppliers',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // Datos comerciales
    legalName: text('legal_name').notNull(),
    tradeName: text('trade_name'),
    taxId: text('tax_id'),
    website: text('website'),
    // País y ubicación
    countryCode: text('country_code').notNull(),
    province: text('province'),
    city: text('city'),
    address: text('address'),
    // Contactos y medios de pago (JSON validado con Zod en el borde)
    contacts: text('contacts', { mode: 'json' }).$type<SupplierContact[]>().notNull().default([]),
    paymentMethods: text('payment_methods', { mode: 'json' })
      .$type<PaymentMethod[]>()
      .notNull()
      .default([]),
    // Despacho y plazos
    directDispatch: integer('direct_dispatch', { mode: 'boolean' }).notNull(),
    dispatchLeadTimeDaysMin: integer('dispatch_lead_time_days_min'),
    dispatchLeadTimeDaysMax: integer('dispatch_lead_time_days_max'),
    deliveryTimeDaysMin: integer('delivery_time_days_min'),
    deliveryTimeDaysMax: integer('delivery_time_days_max'),
    // Devoluciones y seguimiento
    acceptsReturns: integer('accepts_returns', { mode: 'boolean' }).notNull(),
    returnWindowDays: integer('return_window_days'),
    returnPolicyNotes: text('return_policy_notes'),
    trackingAvailable: integer('tracking_available', { mode: 'boolean' }).notNull(),
    // Condiciones de pago al proveedor
    requiresPrepayment: integer('requires_prepayment', { mode: 'boolean' }).notNull(),
    paymentDueDays: integer('payment_due_days'),
    // Estado y puntuación
    status: text('status', { enum: SUPPLIER_STATUS }).notNull().default('UNVERIFIED'),
    score: integer('score').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index('suppliers_tenant_status_idx').on(t.tenantId, t.status),
    index('suppliers_tenant_tax_id_idx').on(t.tenantId, t.taxId),
  ],
);

/** Evidencia de verificación (identidad, condiciones comerciales, despacho). */
export const supplierEvidence = sqliteTable(
  'supplier_evidence',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    supplierId: text('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    category: text('category', {
      enum: ['IDENTITY', 'COMMERCIAL_TERMS', 'DISPATCH_CAPABILITY', 'OTHER'],
    }).notNull(),
    description: text('description').notNull(),
    reference: text('reference').notNull(),
    reviewStatus: text('review_status', { enum: ['PENDING', 'ACCEPTED', 'REJECTED'] })
      .notNull()
      .default('PENDING'),
    reviewNotes: text('review_notes'),
    reviewedByUserId: text('reviewed_by_user_id'),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
    recordedByUserId: text('recorded_by_user_id'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(epochMsDefault),
  },
  (t) => [index('supplier_evidence_supplier_idx').on(t.supplierId, t.category)],
);

/** Historial de verificación: cada cambio de estado (append-only). */
export const supplierStatusHistory = sqliteTable(
  'supplier_status_history',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    supplierId: text('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status', { enum: SUPPLIER_STATUS }).notNull(),
    toStatus: text('to_status', { enum: SUPPLIER_STATUS }).notNull(),
    reason: text('reason').notNull(),
    actorUserId: text('actor_user_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(epochMsDefault),
  },
  (t) => [index('supplier_status_history_supplier_idx').on(t.supplierId, t.createdAt)],
);

export type SupplierRow = typeof suppliers.$inferSelect;
export type NewSupplierRow = typeof suppliers.$inferInsert;
export type SupplierEvidenceRow = typeof supplierEvidence.$inferSelect;
export type SupplierStatusHistoryRow = typeof supplierStatusHistory.$inferSelect;

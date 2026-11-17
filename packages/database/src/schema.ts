import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { timestamps } from './columns';

/**
 * Esquema base (D1 / SQLite): multi-tenant, usuarios y auditoría.
 * Las tablas de dominio viven en ./tables/* y se re-exportan al final.
 *
 * Convenciones: ver docs/DATABASE.md.
 */

export const tenants = sqliteTable(
  'tenants',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: text('status', { enum: ['active', 'suspended'] })
      .notNull()
      .default('active'),
    ...timestamps,
  },
  (t) => [uniqueIndex('tenants_slug_uq').on(t.slug)],
);

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    displayName: text('display_name'),
    role: text('role', { enum: ['owner', 'admin', 'operator', 'viewer'] })
      .notNull()
      .default('viewer'),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_tenant_email_uq').on(t.tenantId, t.email),
    index('users_tenant_idx').on(t.tenantId),
  ],
);

/** Registro inmutable de acciones relevantes (append-only). */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    actorUserId: text('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    /** JSON ya redactado (sin secretos ni datos sensibles). */
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(true),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('audit_events_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('audit_events_entity_idx').on(t.entityType, t.entityId),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;

export * from './tables/suppliers';
export * from './tables/catalog';
export * from './tables/profit';
export * from './tables/automation';
export * from './tables/discovery';
export * from './tables/channels';

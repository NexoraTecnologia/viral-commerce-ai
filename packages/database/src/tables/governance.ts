import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { epochMsDefault } from '../columns';
import { tenants } from '../schema';

/**
 * Propuestas de cambio de reglas. El dashboard NO modifica reglas: solo registra
 * la propuesta. Aplicarla requiere autorización del titular (variable de entorno
 * + despliegue; en el futuro, aprobación con rol owner).
 */
export const ruleChangeRequests = sqliteTable(
  'rule_change_requests',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    ruleKey: text('rule_key').notNull(),
    currentValue: text('current_value').notNull(),
    proposedValue: text('proposed_value').notNull(),
    reason: text('reason').notNull(),
    financial: integer('financial', { mode: 'boolean' }).notNull(),
    status: text('status', { enum: ['PENDING_AUTHORIZATION', 'WITHDRAWN'] }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(epochMsDefault),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(epochMsDefault),
  },
  (t) => [index('rule_change_requests_tenant_idx').on(t.tenantId, t.createdAt)],
);

export type RuleChangeRequestRow = typeof ruleChangeRequests.$inferSelect;

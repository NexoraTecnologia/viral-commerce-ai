import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { epochMsDefault, timestamps } from '../columns';
import { tenants } from '../schema';
import { products, supplierProducts } from './catalog';
import { channelOrders } from './channels';
import { suppliers } from './suppliers';

const CURRENCY = ['ARS', 'USD'] as const;
const ORDER_STATE = [
  'NEW',
  'PAYMENT_PENDING',
  'PAYMENT_CONFIRMED',
  'SUPPLIER_STOCK_VERIFIED',
  'FINANCIAL_APPROVED',
  'SUPPLIER_ORDER_ACCEPTED',
  'SHIPPED',
  'DELIVERED',
  'SETTLED',
  'BLOCKED_NO_STOCK',
  'BLOCKED_CASHFLOW',
  'BLOCKED_SUPPLIER',
  'MANUAL_REVIEW',
  'REFUND_REQUIRED',
  'CANCELLED',
] as const;

const tenantRef = () =>
  text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const ms = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    /** Número correlativo por tenant (visible para el comprador). */
    number: integer('number').notNull(),
    source: text('source', { enum: ['MANUAL', 'CHANNEL'] }).notNull(),
    channelOrderId: text('channel_order_id').references(() => channelOrders.id, {
      onDelete: 'set null',
    }),
    externalOrderId: text('external_order_id'),
    state: text('state', { enum: ORDER_STATE }).notNull().default('NEW'),
    stateReason: text('state_reason'),
    /** Referencia del comprador sin datos personales. */
    buyerRef: text('buyer_ref').notNull(),
    currency: text('currency', { enum: CURRENCY }).notNull(),
    totalCents: integer('total_cents').notNull(),
    expectedSettlementAt: ms('expected_settlement_at'),
    /** Proveedores que rechazaron o no respondieron este pedido. */
    excludedSupplierIds: text('excluded_supplier_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull(),
    /** Fondos reservados al aprobar la validación financiera (se liberan al pagar o cancelar). */
    reservedFundsCents: integer('reserved_funds_cents').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('orders_tenant_number_uq').on(t.tenantId, t.number),
    uniqueIndex('orders_channel_order_uq').on(t.tenantId, t.channelOrderId),
    index('orders_tenant_state_idx').on(t.tenantId, t.state),
  ],
);

export const orderItems = sqliteTable('order_items', {
  id: text('id').primaryKey(),
  tenantId: tenantRef(),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  productId: text('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  quantity: integer('quantity').notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
  supplierProductId: text('supplier_product_id').references(() => supplierProducts.id, {
    onDelete: 'set null',
  }),
});

/** Cobros y reembolsos, SIEMPRE con evidencia del canal de pago. */
export const orderPayments = sqliteTable(
  'order_payments',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['CHARGE', 'REFUND'] }).notNull(),
    provider: text('provider').notNull(),
    externalPaymentId: text('external_payment_id').notNull(),
    status: text('status', { enum: ['PENDING', 'APPROVED', 'REJECTED'] }).notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency', { enum: CURRENCY }).notNull(),
    evidenceSource: text('evidence_source', {
      enum: ['CHANNEL_WEBHOOK', 'CHANNEL_API', 'PAYMENT_PROVIDER_REPORT', 'MANUAL_EVIDENCE'],
    }).notNull(),
    evidenceRef: text('evidence_ref').notNull(),
    observedAt: ms('observed_at').notNull(),
    recordedAt: ms('recorded_at').notNull().default(epochMsDefault),
  },
  (t) => [
    // Idempotencia: el mismo evento del canal de pago no se registra dos veces.
    uniqueIndex('order_payments_event_uq').on(
      t.tenantId,
      t.provider,
      t.externalPaymentId,
      t.kind,
      t.status,
    ),
    index('order_payments_order_idx').on(t.orderId),
  ],
);

export const supplierOrders = sqliteTable(
  'supplier_orders',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    supplierId: text('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    status: text('status', {
      enum: ['SELECTED', 'REQUESTED', 'ACCEPTED', 'REJECTED', 'NO_RESPONSE', 'CANCELLED'],
    }).notNull(),
    costCents: integer('cost_cents').notNull(),
    currency: text('currency', { enum: CURRENCY }).notNull(),
    requestRef: text('request_ref'),
    requestedAt: ms('requested_at'),
    responseDueAt: ms('response_due_at'),
    confirmationRef: text('confirmation_ref'),
    confirmedAt: ms('confirmed_at'),
    rejectionReason: text('rejection_reason'),
    ...timestamps,
  },
  (t) => [
    index('supplier_orders_order_idx').on(t.orderId),
    index('supplier_orders_due_idx').on(t.status, t.responseDueAt),
  ],
);

export const shipments = sqliteTable(
  'shipments',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    supplierOrderId: text('supplier_order_id').references(() => supplierOrders.id, {
      onDelete: 'set null',
    }),
    carrier: text('carrier').notNull(),
    trackingNumber: text('tracking_number').notNull(),
    trackingUrl: text('tracking_url'),
    status: text('status', { enum: ['SHIPPED', 'DELAYED', 'DELIVERED', 'RETURNED'] }).notNull(),
    confirmationSource: text('confirmation_source', {
      enum: ['SUPPLIER_DOCUMENT', 'CARRIER_TRACKING', 'CHANNEL'],
    }).notNull(),
    confirmationRef: text('confirmation_ref').notNull(),
    shippedAt: ms('shipped_at').notNull(),
    estimatedDeliveryAt: ms('estimated_delivery_at'),
    deliveredAt: ms('delivered_at'),
    deliveryEvidenceRef: text('delivery_evidence_ref'),
    ...timestamps,
  },
  (t) => [
    index('shipments_order_idx').on(t.orderId),
    index('shipments_status_eta_idx').on(t.status, t.estimatedDeliveryAt),
  ],
);

export const orderReturns = sqliteTable('order_returns', {
  id: text('id').primaryKey(),
  tenantId: tenantRef(),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  status: text('status', {
    enum: ['REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'REFUNDED'],
  }).notNull(),
  reason: text('reason').notNull(),
  decisionNote: text('decision_note'),
  receivedEvidenceRef: text('received_evidence_ref'),
  requestedAt: ms('requested_at').notNull(),
  updatedAt: timestamps.updatedAt,
});

/** Movimientos económicos del pedido, cada uno con su comprobante. */
export const orderLedgerEntries = sqliteTable(
  'order_ledger_entries',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: [
        'SALE',
        'CHANNEL_FEE',
        'PAYMENT_FEE',
        'SUPPLIER_COST',
        'SHIPPING_COST',
        'TAX',
        'REFUND',
        'ADJUSTMENT',
      ],
    }).notNull(),
    /** Con signo: + ingreso, − egreso. */
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency', { enum: CURRENCY }).notNull(),
    sourceRef: text('source_ref').notNull(),
    occurredAt: ms('occurred_at').notNull(),
    recordedAt: ms('recorded_at').notNull().default(epochMsDefault),
  },
  (t) => [index('order_ledger_order_idx').on(t.orderId)],
);

/** Registro completo (append-only) de todo lo que le pasa a un pedido. */
export const orderEvents = sqliteTable(
  'order_events',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    fromState: text('from_state', { enum: ORDER_STATE }),
    toState: text('to_state', { enum: ORDER_STATE }),
    actor: text('actor', { enum: ['SYSTEM', 'USER', 'AGENT'] }).notNull(),
    detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    createdAt: ms('created_at').notNull().default(epochMsDefault),
  },
  (t) => [index('order_events_order_idx').on(t.orderId, t.createdAt)],
);

/** Saldo de fondos disponible, con fuente y fecha (dato real cargado, nunca supuesto). */
export const fundsSnapshots = sqliteTable(
  'funds_snapshots',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    availableCents: integer('available_cents').notNull(),
    currency: text('currency', { enum: CURRENCY }).notNull(),
    asOf: ms('as_of').notNull(),
    source: text('source', { enum: ['MANUAL', 'SUPPLIER_REPORT', 'INTEGRATION'] }).notNull(),
    sourceRef: text('source_ref').notNull(),
    recordedAt: ms('recorded_at').notNull().default(epochMsDefault),
  },
  (t) => [index('funds_snapshots_tenant_idx').on(t.tenantId, t.currency, t.asOf)],
);

/* ============================ Atención al cliente ============================ */

export const supportTickets = sqliteTable(
  'support_tickets',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    orderId: text('order_id').references(() => orders.id, { onDelete: 'set null' }),
    channel: text('channel', {
      enum: ['WHATSAPP', 'MERCADO_LIBRE', 'INSTAGRAM', 'OWN_STORE', 'EMAIL', 'OTHER'],
    }).notNull(),
    contactRef: text('contact_ref').notNull(),
    subject: text('subject').notNull(),
    status: text('status', { enum: ['OPEN', 'ANSWERED', 'ESCALATED', 'CLOSED'] }).notNull(),
    escalationReason: text('escalation_reason'),
    escalatedAt: ms('escalated_at'),
    ...timestamps,
  },
  (t) => [index('support_tickets_tenant_status_idx').on(t.tenantId, t.status)],
);

export const supportMessages = sqliteTable(
  'support_messages',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    direction: text('direction', { enum: ['INBOUND', 'OUTBOUND'] }).notNull(),
    body: text('body').notNull(),
    templateKey: text('template_key'),
    faqId: text('faq_id'),
    status: text('status', { enum: ['RECEIVED', 'DRAFT', 'BLOCKED', 'SENT'] }).notNull(),
    detail: text('detail'),
    createdAt: ms('created_at').notNull().default(epochMsDefault),
  },
  (t) => [index('support_messages_ticket_idx').on(t.ticketId, t.createdAt)],
);

export const faqEntries = sqliteTable('faq_entries', {
  id: text('id').primaryKey(),
  tenantId: tenantRef(),
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  keywords: text('keywords', { mode: 'json' }).$type<string[]>().notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  ...timestamps,
});

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type OrderPaymentRow = typeof orderPayments.$inferSelect;
export type SupplierOrderRow = typeof supplierOrders.$inferSelect;
export type ShipmentRow = typeof shipments.$inferSelect;
export type OrderReturnRow = typeof orderReturns.$inferSelect;
export type OrderLedgerRow = typeof orderLedgerEntries.$inferSelect;
export type OrderEventRow = typeof orderEvents.$inferSelect;
export type FundsSnapshotRow = typeof fundsSnapshots.$inferSelect;
export type SupportTicketRow = typeof supportTickets.$inferSelect;
export type SupportMessageRow = typeof supportMessages.$inferSelect;
export type FaqRow = typeof faqEntries.$inferSelect;

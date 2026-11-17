import { z } from 'zod';
import { CurrencySchema } from '../money';
import { CentsSchema, DataSourceSchema, IsoDateTimeSchema } from './common';
import { FinancialGuardIssueSchema } from './profit';

/* =================================== Estados =================================== */

/** Flujo principal del pedido. */
export const ORDER_FLOW_STATES = [
  'NEW',
  'PAYMENT_PENDING',
  'PAYMENT_CONFIRMED',
  'SUPPLIER_STOCK_VERIFIED',
  'FINANCIAL_APPROVED',
  'SUPPLIER_ORDER_ACCEPTED',
  'SHIPPED',
  'DELIVERED',
  'SETTLED',
] as const;

/** Bloqueos: el pedido no avanza hasta resolverse. */
export const ORDER_BLOCK_STATES = [
  'BLOCKED_NO_STOCK',
  'BLOCKED_CASHFLOW',
  'BLOCKED_SUPPLIER',
  'MANUAL_REVIEW',
  'REFUND_REQUIRED',
] as const;

/**
 * CANCELLED: estado terminal agregado para la gestión de cancelaciones
 * (incluye pedidos anulados con reembolso acreditado con evidencia).
 */
export const OrderStateSchema = z.enum([...ORDER_FLOW_STATES, ...ORDER_BLOCK_STATES, 'CANCELLED']);
export type OrderState = z.infer<typeof OrderStateSchema>;

export const OrderSourceSchema = z.enum(['MANUAL', 'CHANNEL']);
export type OrderSource = z.infer<typeof OrderSourceSchema>;

/* =================================== Pagos =================================== */

/** De dónde sale la evidencia del pago. Sin evidencia del canal de pago no hay pago confirmado. */
export const PaymentEvidenceSourceSchema = z.enum([
  'CHANNEL_WEBHOOK',
  'CHANNEL_API',
  'PAYMENT_PROVIDER_REPORT',
  'MANUAL_EVIDENCE',
]);
export type PaymentEvidenceSource = z.infer<typeof PaymentEvidenceSourceSchema>;

export const PaymentStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED']);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
export const PaymentKindSchema = z.enum(['CHARGE', 'REFUND']);
export type PaymentKind = z.infer<typeof PaymentKindSchema>;

export const OrderPaymentDtoSchema = z.object({
  id: z.uuid(),
  kind: PaymentKindSchema,
  provider: z.string(),
  externalPaymentId: z.string(),
  status: PaymentStatusSchema,
  amountCents: z.number().int(),
  currency: CurrencySchema,
  evidenceSource: PaymentEvidenceSourceSchema,
  evidenceRef: z.string(),
  observedAt: IsoDateTimeSchema,
  recordedAt: IsoDateTimeSchema,
});
export type OrderPaymentDto = z.infer<typeof OrderPaymentDtoSchema>;

export const RecordPaymentRequestSchema = z.object({
  kind: PaymentKindSchema.default('CHARGE'),
  /** Medio o canal de pago (p. ej. "Mercado Pago", "Mercado Libre"). */
  provider: z.string().trim().min(2).max(60),
  /** ID de la operación en el canal de pago. */
  externalPaymentId: z.string().trim().min(3).max(120),
  status: PaymentStatusSchema,
  amountCents: CentsSchema,
  currency: CurrencySchema,
  evidenceSource: PaymentEvidenceSourceSchema,
  /** Comprobante verificable: ID de notificación, URL del panel, n.º de reporte. */
  evidenceRef: z.string().trim().min(3).max(500),
  observedAt: IsoDateTimeSchema,
});
export type RecordPaymentRequest = z.input<typeof RecordPaymentRequestSchema>;

/* ============================ Proveedor y despacho ============================ */

export const SupplierOrderStatusSchema = z.enum([
  'SELECTED',
  'REQUESTED',
  'ACCEPTED',
  'REJECTED',
  'NO_RESPONSE',
  'CANCELLED',
]);
export type SupplierOrderStatus = z.infer<typeof SupplierOrderStatusSchema>;

export const SupplierOrderDtoSchema = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  supplierName: z.string(),
  status: SupplierOrderStatusSchema,
  costCents: z.number().int(),
  currency: CurrencySchema,
  requestRef: z.string().nullable(),
  requestedAt: IsoDateTimeSchema.nullable(),
  responseDueAt: IsoDateTimeSchema.nullable(),
  confirmationRef: z.string().nullable(),
  confirmedAt: IsoDateTimeSchema.nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type SupplierOrderDto = z.infer<typeof SupplierOrderDtoSchema>;

export const RequestDispatchRequestSchema = z.object({
  /** Referencia del pedido enviado al proveedor (n.º de OC, email, ticket). */
  requestRef: z.string().trim().min(3).max(500),
  responseHours: z.number().int().min(1).max(168).default(24),
});
export type RequestDispatchRequest = z.input<typeof RequestDispatchRequestSchema>;

export const SupplierResponseRequestSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('ACCEPTED'),
    /** Comprobante de aceptación del proveedor. */
    confirmationRef: z.string().trim().min(3).max(500),
  }),
  z.object({ decision: z.literal('REJECTED'), reason: z.string().trim().min(3).max(500) }),
]);
export type SupplierResponseRequest = z.infer<typeof SupplierResponseRequestSchema>;

export const ShipmentStatusSchema = z.enum(['SHIPPED', 'DELAYED', 'DELIVERED', 'RETURNED']);
export type ShipmentStatus = z.infer<typeof ShipmentStatusSchema>;

export const ShipmentConfirmationSourceSchema = z.enum([
  'SUPPLIER_DOCUMENT',
  'CARRIER_TRACKING',
  'CHANNEL',
]);
export type ShipmentConfirmationSource = z.infer<typeof ShipmentConfirmationSourceSchema>;

export const ShipmentDtoSchema = z.object({
  id: z.uuid(),
  carrier: z.string(),
  trackingNumber: z.string(),
  trackingUrl: z.string().nullable(),
  status: ShipmentStatusSchema,
  confirmationSource: ShipmentConfirmationSourceSchema,
  confirmationRef: z.string(),
  shippedAt: IsoDateTimeSchema,
  estimatedDeliveryAt: IsoDateTimeSchema.nullable(),
  deliveredAt: IsoDateTimeSchema.nullable(),
  deliveryEvidenceRef: z.string().nullable(),
});
export type ShipmentDto = z.infer<typeof ShipmentDtoSchema>;

export const RegisterShipmentRequestSchema = z.object({
  carrier: z.string().trim().min(2).max(80),
  trackingNumber: z.string().trim().min(4).max(80),
  trackingUrl: z.url({ protocol: /^https$/ }).optional(),
  confirmationSource: ShipmentConfirmationSourceSchema,
  /** Comprobante verificable del despacho (guía, remito, evento del transportista). */
  confirmationRef: z.string().trim().min(3).max(500),
  shippedAt: IsoDateTimeSchema,
  estimatedDeliveryAt: IsoDateTimeSchema.optional(),
});
export type RegisterShipmentRequest = z.infer<typeof RegisterShipmentRequestSchema>;

export const ShipmentEventRequestSchema = z.object({
  status: z.enum(['DELIVERED', 'DELAYED']),
  evidenceRef: z.string().trim().min(3).max(500),
  occurredAt: IsoDateTimeSchema,
  /** Nueva fecha estimada informada por el transportista (solo DELAYED). */
  newEstimatedDeliveryAt: IsoDateTimeSchema.optional(),
});
export type ShipmentEventRequest = z.infer<typeof ShipmentEventRequestSchema>;

/* =========================== Cancelaciones y devoluciones =========================== */

export const CancelOrderRequestSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const ReturnStatusSchema = z.enum([
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'RECEIVED',
  'REFUNDED',
]);
export type ReturnStatus = z.infer<typeof ReturnStatusSchema>;

export const OrderReturnDtoSchema = z.object({
  id: z.uuid(),
  status: ReturnStatusSchema,
  reason: z.string(),
  decisionNote: z.string().nullable(),
  receivedEvidenceRef: z.string().nullable(),
  requestedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type OrderReturnDto = z.infer<typeof OrderReturnDtoSchema>;

export const RequestReturnSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const ReturnDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().trim().min(3).max(500),
});
export const ReturnReceivedSchema = z.object({ evidenceRef: z.string().trim().min(3).max(500) });

export const ResolveReviewRequestSchema = z.object({
  to: OrderStateSchema,
  reason: z.string().trim().min(3).max(500),
});
export type ResolveReviewRequest = z.infer<typeof ResolveReviewRequestSchema>;

/* ============================ Conciliación económica ============================ */

export const LedgerEntryTypeSchema = z.enum([
  'SALE',
  'CHANNEL_FEE',
  'PAYMENT_FEE',
  'SUPPLIER_COST',
  'SHIPPING_COST',
  'TAX',
  'REFUND',
  'ADJUSTMENT',
]);
export type LedgerEntryType = z.infer<typeof LedgerEntryTypeSchema>;

export const LedgerEntryDtoSchema = z.object({
  id: z.uuid(),
  type: LedgerEntryTypeSchema,
  /** Positivo = ingreso; negativo = egreso. */
  amountCents: z.number().int(),
  currency: CurrencySchema,
  sourceRef: z.string(),
  occurredAt: IsoDateTimeSchema,
  recordedAt: IsoDateTimeSchema,
});
export type LedgerEntryDto = z.infer<typeof LedgerEntryDtoSchema>;

export const RecordLedgerEntryRequestSchema = z.object({
  type: LedgerEntryTypeSchema,
  /** Monto en valor absoluto; el signo lo define el tipo (ADJUSTMENT admite signo). */
  amountCents: z
    .number()
    .int()
    .refine((v) => Number.isSafeInteger(v), 'Monto inválido'),
  currency: CurrencySchema,
  /** Liquidación del canal, factura del proveedor, comprobante bancario, etc. */
  sourceRef: z.string().trim().min(3).max(500),
  occurredAt: IsoDateTimeSchema,
});
export type RecordLedgerEntryRequest = z.infer<typeof RecordLedgerEntryRequestSchema>;

export const ReconciliationStatusSchema = z.enum(['PENDING_DATA', 'MATCHED', 'MISMATCH']);
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>;

export const ReconciliationDtoSchema = z.object({
  status: ReconciliationStatusSchema,
  currency: CurrencySchema,
  revenueCents: z.number().int(),
  costsCents: z.number().int(),
  refundsCents: z.number().int(),
  netCents: z.number().int(),
  /** Neto esperado según el Profit Engine (null si no se pudo calcular). */
  expectedNetCents: z.number().int().nullable(),
  differenceCents: z.number().int().nullable(),
  missing: z.array(z.string()),
  notes: z.array(z.string()),
});
export type ReconciliationDto = z.infer<typeof ReconciliationDtoSchema>;

/* ================================ Fondos ================================ */

export const FundsSnapshotDtoSchema = z.object({
  id: z.uuid(),
  availableCents: z.number().int(),
  currency: CurrencySchema,
  asOf: IsoDateTimeSchema,
  source: DataSourceSchema,
  sourceRef: z.string(),
  recordedAt: IsoDateTimeSchema,
});
export type FundsSnapshotDto = z.infer<typeof FundsSnapshotDtoSchema>;

export const RecordFundsSnapshotRequestSchema = z.object({
  availableCents: CentsSchema,
  currency: CurrencySchema,
  asOf: IsoDateTimeSchema,
  source: DataSourceSchema,
  /** Extracto bancario, saldo de la billetera, etc. */
  sourceRef: z.string().trim().min(3).max(500),
});
export type RecordFundsSnapshotRequest = z.infer<typeof RecordFundsSnapshotRequestSchema>;

export const FinancialCheckDtoSchema = z.object({
  decision: z.enum(['APPROVED', 'BLOCKED']),
  issues: z.array(
    z.union([
      FinancialGuardIssueSchema,
      z.literal('NO_FUNDS_DATA'),
      z.literal('COST_DATA_INVALID'),
    ]),
  ),
  availableCents: z.number().int().nullable(),
  committedCents: z.number().int(),
  requiredFundsCents: z.number().int(),
  supplierCostCents: z.number().int(),
  evaluatedAt: IsoDateTimeSchema,
});
export type FinancialCheckDto = z.infer<typeof FinancialCheckDtoSchema>;

/* ================================ Pedido ================================ */

export const OrderItemDtoSchema = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  title: z.string(),
  quantity: z.number().int(),
  unitPriceCents: z.number().int(),
  supplierProductId: z.uuid().nullable(),
});
export type OrderItemDto = z.infer<typeof OrderItemDtoSchema>;

export const OrderDtoSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  source: OrderSourceSchema,
  channelOrderId: z.uuid().nullable(),
  externalOrderId: z.string().nullable(),
  state: OrderStateSchema,
  stateReason: z.string().nullable(),
  buyerRef: z.string(),
  totalCents: z.number().int(),
  currency: CurrencySchema,
  refunded: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type OrderDto = z.infer<typeof OrderDtoSchema>;

export const OrderEventDtoSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  fromState: OrderStateSchema.nullable(),
  toState: OrderStateSchema.nullable(),
  actor: z.enum(['SYSTEM', 'USER', 'AGENT']),
  detail: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTimeSchema,
});
export type OrderEventDto = z.infer<typeof OrderEventDtoSchema>;

export const OrderDetailDtoSchema = z.object({
  order: OrderDtoSchema,
  items: z.array(OrderItemDtoSchema),
  payments: z.array(OrderPaymentDtoSchema),
  supplierOrders: z.array(SupplierOrderDtoSchema),
  shipments: z.array(ShipmentDtoSchema),
  returns: z.array(OrderReturnDtoSchema),
  ledger: z.array(LedgerEntryDtoSchema),
  reconciliation: ReconciliationDtoSchema,
  financialCheck: FinancialCheckDtoSchema.nullable(),
  events: z.array(OrderEventDtoSchema),
  /** Lo que se le puede decir al comprador HOY, solo con hechos verificados. */
  buyerStatus: z.string(),
  allowedTransitions: z.array(OrderStateSchema),
});
export type OrderDetailDto = z.infer<typeof OrderDetailDtoSchema>;

export const CreateOrderRequestSchema = z.object({
  /** Referencia del comprador sin datos personales (alias, ID del canal). */
  buyerRef: z.string().trim().min(2).max(120),
  currency: CurrencySchema,
  items: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: z.number().int().min(1).max(1000),
        unitPriceCents: CentsSchema.refine((v) => v > 0, 'El precio debe ser mayor a 0'),
      }),
    )
    .min(1)
    .max(50),
  /** Pedido del canal ya sincronizado (opcional). */
  channelOrderId: z.uuid().optional(),
  externalOrderId: z.string().trim().max(80).optional(),
  /** Fecha en que el canal liquida el dinero, si el canal la informa. */
  expectedSettlementAt: IsoDateTimeSchema.optional(),
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

/* ============================ Atención al cliente ============================ */

export const TicketChannelSchema = z.enum([
  'WHATSAPP',
  'MERCADO_LIBRE',
  'INSTAGRAM',
  'OWN_STORE',
  'EMAIL',
  'OTHER',
]);
export const TicketStatusSchema = z.enum(['OPEN', 'ANSWERED', 'ESCALATED', 'CLOSED']);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

export const CustomerTemplateKeySchema = z.enum([
  'ORDER_RECEIVED',
  'PAYMENT_PENDING',
  'PAYMENT_CONFIRMED',
  'IN_PREPARATION',
  'SHIPPED',
  'DELIVERED',
  'SHIPPING_DELAYED',
  'RETURN_INSTRUCTIONS',
  'REFUND_IN_PROCESS',
  'ORDER_CANCELLED',
  'ESCALATED',
]);
export type CustomerTemplateKey = z.infer<typeof CustomerTemplateKeySchema>;

export const SupportMessageDtoSchema = z.object({
  id: z.uuid(),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  body: z.string(),
  templateKey: CustomerTemplateKeySchema.nullable(),
  faqId: z.uuid().nullable(),
  status: z.enum(['RECEIVED', 'DRAFT', 'BLOCKED', 'SENT']),
  detail: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type SupportMessageDto = z.infer<typeof SupportMessageDtoSchema>;

export const SupportTicketDtoSchema = z.object({
  id: z.uuid(),
  orderId: z.uuid().nullable(),
  orderNumber: z.number().int().nullable(),
  channel: TicketChannelSchema,
  contactRef: z.string(),
  subject: z.string(),
  status: TicketStatusSchema,
  escalationReason: z.string().nullable(),
  escalatedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  messages: z.array(SupportMessageDtoSchema),
  /** Respuestas sugeridas (FAQ y plantillas disponibles con hechos verificados). */
  suggestions: z.array(
    z.object({
      kind: z.enum(['FAQ', 'TEMPLATE']),
      key: z.string(),
      label: z.string(),
      body: z.string(),
    }),
  ),
});
export type SupportTicketDto = z.infer<typeof SupportTicketDtoSchema>;

export const CreateTicketRequestSchema = z.object({
  orderId: z.uuid().optional(),
  channel: TicketChannelSchema,
  contactRef: z.string().trim().min(2).max(120),
  subject: z.string().trim().min(3).max(200),
  message: z.string().trim().min(1).max(4000),
});
export type CreateTicketRequest = z.infer<typeof CreateTicketRequestSchema>;

export const ReplyTicketRequestSchema = z
  .object({
    templateKey: CustomerTemplateKeySchema.optional(),
    faqId: z.uuid().optional(),
    text: z.string().trim().min(1).max(4000).optional(),
  })
  .refine((v) => [v.templateKey, v.faqId, v.text].filter((x) => x !== undefined).length === 1, {
    message: 'Indicar una plantilla, una FAQ o un texto (uno solo)',
  });
export type ReplyTicketRequest = z.infer<typeof ReplyTicketRequestSchema>;

export const EscalateTicketRequestSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const FaqDtoSchema = z.object({
  id: z.uuid(),
  question: z.string(),
  answer: z.string(),
  keywords: z.array(z.string()),
  active: z.boolean(),
});
export type FaqDto = z.infer<typeof FaqDtoSchema>;

export const CreateFaqRequestSchema = z.object({
  question: z.string().trim().min(5).max(300),
  answer: z.string().trim().min(5).max(2000),
  keywords: z.array(z.string().trim().min(2).max(40)).min(1).max(20),
});
export type CreateFaqRequest = z.infer<typeof CreateFaqRequestSchema>;

/* ================================ Simulaciones ================================ */

export const SimulationScenarioSchema = z.enum([
  'HAPPY_PATH',
  'PAYMENT_REJECTED',
  'NO_STOCK',
  'SUPPLIER_NO_RESPONSE',
  'CASHFLOW_PROBLEM',
  'SHIPPING_DELAYED',
  'RETURN',
]);
export type SimulationScenario = z.infer<typeof SimulationScenarioSchema>;

export const SimulationResultDtoSchema = z.object({
  scenario: SimulationScenarioSchema,
  title: z.string(),
  description: z.string(),
  steps: z.array(
    z.object({
      at: IsoDateTimeSchema,
      event: z.string(),
      fromState: OrderStateSchema,
      toState: OrderStateSchema,
      detail: z.string(),
    }),
  ),
  finalState: OrderStateSchema,
  buyerMessages: z.array(z.string()),
  /** Acciones que en un pedido real requerirían el interruptor comercial o evidencia externa. */
  blockedActions: z.array(z.string()),
});
export type SimulationResultDto = z.infer<typeof SimulationResultDtoSchema>;

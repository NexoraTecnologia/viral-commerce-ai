import { z } from 'zod';
import { CurrencySchema } from '../money';
import { IsoDateTimeSchema } from './common';
import { OrderStateSchema, ShipmentStatusSchema } from './orders';

/* ================================ Overview ================================ */

const MoneyByCurrency = z.array(z.object({ currency: CurrencySchema, cents: z.number().int() }));

export const FreeTierUsageSchema = z.object({
  resource: z.string(),
  limit: z.number(),
  unit: z.string(),
  /** null = no medido (no se estima ni se inventa). */
  used: z.number().nullable(),
  note: z.string(),
  source: z.string(),
});
export type FreeTierUsage = z.infer<typeof FreeTierUsageSchema>;

export const OverviewDtoSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  commercialActionsEnabled: z.boolean(),
  /** Cobros aprobados con evidencia, netos de reembolsos con evidencia. */
  sales: z.object({
    last30d: MoneyByCurrency,
    total: MoneyByCurrency,
    paidOrders: z.number().int(),
  }),
  /** Solo pedidos SETTLED (conciliados): suma de movimientos con comprobante. */
  netProfit: z.object({ settledOrders: z.number().int(), net: MoneyByCurrency }),
  discovery: z.object({
    researching: z.number().int(),
    candidates: z.number().int(),
    discarded: z.number().int(),
  }),
  listings: z.object({
    publishedLive: z.number().int(),
    publishedMock: z.number().int(),
    ready: z.number().int(),
    blocked: z.number().int(),
  }),
  suppliers: z.object({ verified: z.number().int(), total: z.number().int() }),
  orders: z.object({
    pending: z.number().int(),
    blocked: z.number().int(),
    manualReview: z.number().int(),
    total: z.number().int(),
  }),
  shipments: z.object({
    awaitingDispatch: z.number().int(),
    inTransit: z.number().int(),
    delayed: z.number().int(),
  }),
  jobs24h: z.object({
    completed: z.number().int(),
    failed: z.number().int(),
    deadLetter: z.number().int(),
    active: z.number().int(),
  }),
  errors24h: z.object({
    jobFailures: z.number().int(),
    integrationErrors: z.number().int(),
    webhookProblems: z.number().int(),
    total: z.number().int(),
  }),
  freeTier: z.array(FreeTierUsageSchema),
});
export type OverviewDto = z.infer<typeof OverviewDtoSchema>;

/* ================================ Envíos y clientes ================================ */

export const ShipmentRowDtoSchema = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  orderNumber: z.number().int(),
  orderState: OrderStateSchema,
  carrier: z.string(),
  trackingNumber: z.string(),
  trackingUrl: z.string().nullable(),
  status: ShipmentStatusSchema,
  shippedAt: IsoDateTimeSchema,
  estimatedDeliveryAt: IsoDateTimeSchema.nullable(),
  deliveredAt: IsoDateTimeSchema.nullable(),
  /** Pasó la fecha estimada sin entrega confirmada. */
  overdue: z.boolean(),
});
export type ShipmentRowDto = z.infer<typeof ShipmentRowDtoSchema>;

export const CustomerDtoSchema = z.object({
  buyerRef: z.string(),
  orders: z.number().int(),
  openOrders: z.number().int(),
  paid: MoneyByCurrency,
  lastOrderAt: IsoDateTimeSchema,
  lastOrderNumber: z.number().int(),
});
export type CustomerDto = z.infer<typeof CustomerDtoSchema>;

/* ================================ Auditoría ================================ */

export const PageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  });

export const AuditEventDtoSchema = z.object({
  id: z.uuid(),
  source: z.enum(['SYSTEM', 'ORDER']),
  action: z.string(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  actor: z.string().nullable(),
  dryRun: z.boolean().nullable(),
  detail: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTimeSchema,
});
export type AuditEventDto = z.infer<typeof AuditEventDtoSchema>;

/* ================================ Reglas ================================ */

export const RuleDtoSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  value: z.string(),
  unit: z.string(),
  /** Reglas financieras: solo el titular puede autorizar su cambio. */
  financial: z.boolean(),
  source: z.string(),
});
export type RuleDto = z.infer<typeof RuleDtoSchema>;

export const RuleChangeRequestDtoSchema = z.object({
  id: z.uuid(),
  ruleKey: z.string(),
  currentValue: z.string(),
  proposedValue: z.string(),
  reason: z.string(),
  financial: z.boolean(),
  status: z.enum(['PENDING_AUTHORIZATION', 'WITHDRAWN']),
  createdAt: IsoDateTimeSchema,
});
export type RuleChangeRequestDto = z.infer<typeof RuleChangeRequestDtoSchema>;

export const CreateRuleChangeRequestSchema = z.object({
  ruleKey: z.string().min(3).max(60),
  proposedValue: z.string().trim().min(1).max(40),
  reason: z.string().trim().min(10).max(500),
});
export type CreateRuleChangeRequest = z.infer<typeof CreateRuleChangeRequestSchema>;

/* ================================ Configuración ================================ */

export const SettingsDtoSchema = z.object({
  tenant: z.object({ id: z.uuid(), name: z.string(), slug: z.string(), status: z.string() }),
  environment: z.string(),
  apiVersion: z.string(),
  commercialActionsEnabled: z.boolean(),
  cronTriggers: z.array(z.string()),
  /** Solo presencia (nunca valores) de cada secret. */
  secrets: z.array(z.object({ name: z.string(), configured: z.boolean(), purpose: z.string() })),
});
export type SettingsDto = z.infer<typeof SettingsDtoSchema>;

export const UpdateSettingsRequestSchema = z.object({ name: z.string().trim().min(2).max(120) });

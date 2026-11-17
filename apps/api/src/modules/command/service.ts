import { and, count, desc, eq, gte, inArray, like, or, sql, sum } from 'drizzle-orm';
import {
  auditEvents,
  channelConnections,
  channelListings,
  discoveredProducts,
  integrationLogs,
  jobAttempts,
  jobs,
  orderEvents,
  orderLedgerEntries,
  orderPayments,
  orders,
  ruleChangeRequests,
  shipments,
  suppliers,
  tenants,
  webhookEvents,
  type Database,
} from '@vc/database';
import {
  API_VERSION,
  appError,
  err,
  newId,
  ok,
  type ApiConfig,
  type AuditEventDto,
  type CreateRuleChangeRequest,
  type CustomerDto,
  type FreeTierUsage,
  type OrderState,
  type OverviewDto,
  type Result,
  type RuleChangeRequestDto,
  type RuleDto,
  type SettingsDto,
  type ShipmentRowDto,
} from '@vc/shared';
import type { ChannelSecrets } from '../../env';
import { iso, isoOrNull, notFound } from '../../http';

export interface CommandRuntime {
  readonly db: Database;
  readonly tenantId: string;
  readonly config: ApiConfig;
  readonly now: Date;
}

const DAY = 86_400_000;
const PENDING_STATES: OrderState[] = [
  'NEW',
  'PAYMENT_PENDING',
  'PAYMENT_CONFIRMED',
  'SUPPLIER_STOCK_VERIFIED',
  'FINANCIAL_APPROVED',
  'SUPPLIER_ORDER_ACCEPTED',
];
const BLOCKED_STATES: OrderState[] = [
  'BLOCKED_NO_STOCK',
  'BLOCKED_CASHFLOW',
  'BLOCKED_SUPPLIER',
  'REFUND_REQUIRED',
];

/** Cron Triggers declarados en apps/api/wrangler.jsonc (mantener sincronizado). */
export const CRON_TRIGGERS = ['* * * * *', '*/5 * * * *'];

/**
 * Límites del plan gratuito, verificados en developers.cloudflare.com (2026-11-17):
 * workers/platform/limits, d1/platform/{limits,pricing}, queues/platform/pricing.
 */
export const FREE_TIER_LIMITS = {
  workersRequestsPerDay: 100_000,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  d1MaxDatabaseMb: 500,
  queueOperationsPerDay: 10_000,
  cronTriggersPerAccount: 5,
} as const;

const num = (v: unknown) => Number(v ?? 0);

const byCurrency = (rows: { currency: string; total: unknown }[]) =>
  rows
    .filter((r) => r.currency === 'ARS' || r.currency === 'USD')
    .map((r) => ({ currency: r.currency as 'ARS' | 'USD', cents: num(r.total) }));

/* ================================ Overview ================================ */

/**
 * Indicadores REALES calculados desde la base. No hay valores de ejemplo: lo que
 * no se puede medir se informa como no medido (null).
 */
export const overview = async (rt: CommandRuntime): Promise<OverviewDto> => {
  const t = rt.tenantId;
  const since24h = new Date(rt.now.getTime() - DAY);
  const since30d = new Date(rt.now.getTime() - 30 * DAY);
  const dayStartUtc = new Date(
    Date.UTC(rt.now.getUTCFullYear(), rt.now.getUTCMonth(), rt.now.getUTCDate()),
  );

  // Ventas: cobros aprobados con evidencia menos reembolsos aprobados con evidencia.
  const signed = sql<number>`case when ${orderPayments.kind} = 'REFUND' then -${orderPayments.amountCents} else ${orderPayments.amountCents} end`;
  const approved = and(eq(orderPayments.tenantId, t), eq(orderPayments.status, 'APPROVED'));
  const [salesTotal, sales30, paidOrders] = await Promise.all([
    rt.db
      .select({ currency: orderPayments.currency, total: sum(signed) })
      .from(orderPayments)
      .where(approved)
      .groupBy(orderPayments.currency),
    rt.db
      .select({ currency: orderPayments.currency, total: sum(signed) })
      .from(orderPayments)
      .where(and(approved, gte(orderPayments.observedAt, since30d)))
      .groupBy(orderPayments.currency),
    rt.db
      .select({ n: sql<number>`count(distinct ${orderPayments.orderId})` })
      .from(orderPayments)
      .where(and(approved, eq(orderPayments.kind, 'CHARGE')))
      .get(),
  ]);

  // Beneficio neto: solo pedidos conciliados (SETTLED).
  const [netRows, settled] = await Promise.all([
    rt.db
      .select({ currency: orderLedgerEntries.currency, total: sum(orderLedgerEntries.amountCents) })
      .from(orderLedgerEntries)
      .innerJoin(orders, eq(orderLedgerEntries.orderId, orders.id))
      .where(and(eq(orderLedgerEntries.tenantId, t), eq(orders.state, 'SETTLED')))
      .groupBy(orderLedgerEntries.currency),
    rt.db
      .select({ n: count() })
      .from(orders)
      .where(and(eq(orders.tenantId, t), eq(orders.state, 'SETTLED')))
      .get(),
  ]);

  const countBy = async <C extends string>(rows: Promise<{ k: C; n: number }[]>) =>
    new Map((await rows).map((r) => [r.k, r.n]));

  const [disc, listingRows, sup, ord, ships, jobRows, intErrors, hooks, attemptsToday] =
    await Promise.all([
      countBy(
        rt.db
          .select({ k: discoveredProducts.status, n: count() })
          .from(discoveredProducts)
          .where(eq(discoveredProducts.tenantId, t))
          .groupBy(discoveredProducts.status),
      ),
      rt.db
        .select({ status: channelListings.status, mode: channelConnections.mode, n: count() })
        .from(channelListings)
        .innerJoin(channelConnections, eq(channelListings.connectionId, channelConnections.id))
        .where(eq(channelListings.tenantId, t))
        .groupBy(channelListings.status, channelConnections.mode),
      countBy(
        rt.db
          .select({ k: suppliers.status, n: count() })
          .from(suppliers)
          .where(eq(suppliers.tenantId, t))
          .groupBy(suppliers.status),
      ),
      countBy(
        rt.db
          .select({ k: orders.state, n: count() })
          .from(orders)
          .where(eq(orders.tenantId, t))
          .groupBy(orders.state),
      ),
      rt.db
        .select({
          status: shipments.status,
          overdue: sql<number>`sum(case when ${shipments.estimatedDeliveryAt} < ${rt.now.getTime()} then 1 else 0 end)`,
          n: count(),
        })
        .from(shipments)
        .where(eq(shipments.tenantId, t))
        .groupBy(shipments.status),
      countBy(
        rt.db
          .select({ k: jobs.status, n: count() })
          .from(jobs)
          .where(
            and(
              eq(jobs.tenantId, t),
              or(
                gte(jobs.updatedAt, since24h),
                inArray(jobs.status, ['PENDING', 'SCHEDULED', 'RUNNING', 'RETRYING']),
              ),
            ),
          )
          .groupBy(jobs.status),
      ),
      rt.db
        .select({ n: count() })
        .from(integrationLogs)
        .where(
          and(
            eq(integrationLogs.tenantId, t),
            eq(integrationLogs.outcome, 'ERROR'),
            gte(integrationLogs.createdAt, since24h),
          ),
        )
        .get(),
      rt.db
        .select({ n: count() })
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.tenantId, t),
            inArray(webhookEvents.status, ['FAILED', 'REJECTED']),
            gte(webhookEvents.receivedAt, since24h),
          ),
        )
        .get(),
      rt.db
        .select({ n: count() })
        .from(jobAttempts)
        .innerJoin(jobs, eq(jobAttempts.jobId, jobs.id))
        .where(gte(jobAttempts.startedAt, dayStartUtc))
        .get(),
    ]);

  const g = <K extends string>(m: Map<K, number>, k: K) => m.get(k) ?? 0;
  const listing = (status: string, mode?: 'LIVE' | 'MOCK') =>
    listingRows
      .filter((r) => r.status === status && (!mode || r.mode === mode))
      .reduce((a, r) => a + r.n, 0);
  const shipCount = (s: string) => ships.find((r) => r.status === s)?.n ?? 0;
  const failedJobs = g(jobRows, 'FAILED') + g(jobRows, 'DEAD_LETTER');

  const freeTier: FreeTierUsage[] = [
    {
      resource: 'Workers: solicitudes por día',
      limit: FREE_TIER_LIMITS.workersRequestsPerDay,
      unit: 'solicitudes',
      used: null,
      note: 'No medido: requiere la API de analíticas de Cloudflare (no configurada).',
      source: 'developers.cloudflare.com/workers/platform/limits',
    },
    {
      resource: 'Queues: operaciones por día',
      limit: FREE_TIER_LIMITS.queueOperationsPerDay,
      unit: 'operaciones',
      used: num(attemptsToday?.n) * 3,
      note: 'Estimación propia: 3 operaciones (escritura, lectura, borrado) por intento de trabajo registrado hoy (UTC), en todos los espacios.',
      source: 'developers.cloudflare.com/queues/platform/pricing',
    },
    {
      resource: 'D1: filas leídas por día',
      limit: FREE_TIER_LIMITS.d1RowsReadPerDay,
      unit: 'filas',
      used: null,
      note: 'No medido: requiere la API de analíticas de Cloudflare.',
      source: 'developers.cloudflare.com/d1/platform/pricing',
    },
    {
      resource: 'D1: filas escritas por día',
      limit: FREE_TIER_LIMITS.d1RowsWrittenPerDay,
      unit: 'filas',
      used: null,
      note: 'No medido: requiere la API de analíticas de Cloudflare.',
      source: 'developers.cloudflare.com/d1/platform/pricing',
    },
    {
      resource: 'Cron Triggers por cuenta',
      limit: FREE_TIER_LIMITS.cronTriggersPerAccount,
      unit: 'triggers',
      used: CRON_TRIGGERS.length,
      note: 'Declarados en wrangler.jsonc: Scheduler y Recovery Worker.',
      source: 'developers.cloudflare.com/workers/platform/limits',
    },
  ];

  return {
    generatedAt: iso(rt.now),
    commercialActionsEnabled: rt.config.COMMERCIAL_ACTIONS_ENABLED,
    sales: {
      last30d: byCurrency(sales30),
      total: byCurrency(salesTotal),
      paidOrders: num(paidOrders?.n),
    },
    netProfit: { settledOrders: num(settled?.n), net: byCurrency(netRows) },
    discovery: {
      researching: g(disc, 'RESEARCHING'),
      candidates: g(disc, 'CANDIDATE'),
      discarded: g(disc, 'DISCARDED'),
    },
    listings: {
      publishedLive: listing('PUBLISHED', 'LIVE'),
      publishedMock: listing('PUBLISHED', 'MOCK'),
      ready: listing('READY'),
      blocked: listing('BLOCKED'),
    },
    suppliers: {
      verified: g(sup, 'VERIFIED'),
      total: [...sup.values()].reduce((a, n) => a + n, 0),
    },
    orders: {
      pending: PENDING_STATES.reduce((a, s) => a + g(ord, s), 0),
      blocked: BLOCKED_STATES.reduce((a, s) => a + g(ord, s), 0),
      manualReview: g(ord, 'MANUAL_REVIEW'),
      total: [...ord.values()].reduce((a, n) => a + n, 0),
    },
    shipments: {
      awaitingDispatch: g(ord, 'SUPPLIER_ORDER_ACCEPTED'),
      inTransit: shipCount('SHIPPED') + shipCount('DELAYED'),
      delayed: shipCount('DELAYED') + num(ships.find((r) => r.status === 'SHIPPED')?.overdue),
    },
    jobs24h: {
      completed: g(jobRows, 'COMPLETED'),
      failed: g(jobRows, 'FAILED'),
      deadLetter: g(jobRows, 'DEAD_LETTER'),
      active:
        g(jobRows, 'PENDING') +
        g(jobRows, 'SCHEDULED') +
        g(jobRows, 'RUNNING') +
        g(jobRows, 'RETRYING'),
    },
    errors24h: {
      jobFailures: failedJobs,
      integrationErrors: num(intErrors?.n),
      webhookProblems: num(hooks?.n),
      total: failedJobs + num(intErrors?.n) + num(hooks?.n),
    },
    freeTier,
  };
};

/* ================================ Envíos ================================ */

export const listShipments = async (rt: CommandRuntime): Promise<ShipmentRowDto[]> => {
  const rows = await rt.db
    .select({ s: shipments, o: orders })
    .from(shipments)
    .innerJoin(orders, eq(shipments.orderId, orders.id))
    .where(eq(shipments.tenantId, rt.tenantId))
    .orderBy(desc(shipments.shippedAt))
    .limit(500);
  return rows.map(({ s, o }) => ({
    id: s.id,
    orderId: o.id,
    orderNumber: o.number,
    orderState: o.state,
    carrier: s.carrier,
    trackingNumber: s.trackingNumber,
    trackingUrl: s.trackingUrl,
    status: s.status,
    shippedAt: iso(s.shippedAt),
    estimatedDeliveryAt: isoOrNull(s.estimatedDeliveryAt),
    deliveredAt: isoOrNull(s.deliveredAt),
    overdue:
      (s.status === 'SHIPPED' || s.status === 'DELAYED') &&
      s.estimatedDeliveryAt !== null &&
      s.estimatedDeliveryAt.getTime() < rt.now.getTime(),
  }));
};

/* ================================ Clientes ================================ */

/** Clientes = compradores de pedidos reales (por referencia, sin datos personales). */
export const listCustomers = async (rt: CommandRuntime): Promise<CustomerDto[]> => {
  const orderRows = await rt.db
    .select({
      id: orders.id,
      buyerRef: orders.buyerRef,
      state: orders.state,
      number: orders.number,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(eq(orders.tenantId, rt.tenantId));
  const paidRows = await rt.db
    .select({
      orderId: orderPayments.orderId,
      currency: orderPayments.currency,
      total: sum(
        sql<number>`case when ${orderPayments.kind} = 'REFUND' then -${orderPayments.amountCents} else ${orderPayments.amountCents} end`,
      ),
    })
    .from(orderPayments)
    .where(and(eq(orderPayments.tenantId, rt.tenantId), eq(orderPayments.status, 'APPROVED')))
    .groupBy(orderPayments.orderId, orderPayments.currency);
  const map = new Map<string, CustomerDto & { _last: number }>();
  const open = new Set<OrderState>([
    ...PENDING_STATES,
    ...BLOCKED_STATES,
    'MANUAL_REVIEW',
    'SHIPPED',
    'DELIVERED',
  ]);
  for (const o of orderRows) {
    const c = map.get(o.buyerRef) ?? {
      buyerRef: o.buyerRef,
      orders: 0,
      openOrders: 0,
      paid: [],
      lastOrderAt: iso(o.createdAt),
      lastOrderNumber: o.number,
      _last: 0,
    };
    c.orders++;
    if (open.has(o.state)) c.openOrders++;
    if (o.createdAt.getTime() >= c._last) {
      c._last = o.createdAt.getTime();
      c.lastOrderAt = iso(o.createdAt);
      c.lastOrderNumber = o.number;
    }
    for (const p of paidRows.filter((x) => x.orderId === o.id)) {
      const cur = p.currency;
      const existing = c.paid.find((x) => x.currency === cur);
      if (existing) existing.cents += num(p.total);
      else c.paid.push({ currency: cur, cents: num(p.total) });
    }
    map.set(o.buyerRef, c);
  }
  return [...map.values()]
    .sort((a, b) => b._last - a._last)
    .map((c) => ({
      buyerRef: c.buyerRef,
      orders: c.orders,
      openOrders: c.openOrders,
      paid: c.paid,
      lastOrderAt: c.lastOrderAt,
      lastOrderNumber: c.lastOrderNumber,
    }));
};

/* ================================ Auditoría ================================ */

export interface AuditQuery {
  readonly source: 'SYSTEM' | 'ORDER';
  readonly page: number;
  readonly pageSize: number;
  readonly q?: string | undefined;
}

/** Auditoría paginada en el servidor (puede crecer mucho). */
export const listAudit = async (rt: CommandRuntime, query: AuditQuery) => {
  const offset = (query.page - 1) * query.pageSize;
  const pattern = query.q ? `%${query.q.replace(/[%_]/g, '')}%` : null;
  if (query.source === 'SYSTEM') {
    const where = and(
      eq(auditEvents.tenantId, rt.tenantId),
      pattern
        ? or(
            like(auditEvents.action, pattern),
            like(auditEvents.entityType, pattern),
            like(auditEvents.entityId, pattern),
          )
        : undefined,
    );
    const [rows, total] = await Promise.all([
      rt.db
        .select()
        .from(auditEvents)
        .where(where)
        .orderBy(desc(auditEvents.createdAt))
        .limit(query.pageSize)
        .offset(offset),
      rt.db.select({ n: count() }).from(auditEvents).where(where).get(),
    ]);
    const items: AuditEventDto[] = rows.map((r) => ({
      id: r.id,
      source: 'SYSTEM',
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      actor: r.actorUserId,
      dryRun: r.dryRun,
      detail: r.metadata ?? {},
      createdAt: iso(r.createdAt),
    }));
    return { items, total: num(total?.n), page: query.page, pageSize: query.pageSize };
  }
  const where = and(
    eq(orderEvents.tenantId, rt.tenantId),
    pattern ? or(like(orderEvents.type, pattern), like(orderEvents.toState, pattern)) : undefined,
  );
  const [rows, total] = await Promise.all([
    rt.db
      .select({ e: orderEvents, number: orders.number })
      .from(orderEvents)
      .innerJoin(orders, eq(orderEvents.orderId, orders.id))
      .where(where)
      .orderBy(desc(orderEvents.createdAt))
      .limit(query.pageSize)
      .offset(offset),
    rt.db.select({ n: count() }).from(orderEvents).where(where).get(),
  ]);
  const items: AuditEventDto[] = rows.map(({ e, number }) => ({
    id: e.id,
    source: 'ORDER',
    action: e.toState ? `${e.type} → ${e.toState}` : e.type,
    entityType: 'order',
    entityId: `#${number}`,
    actor: e.actor,
    dryRun: null,
    detail: e.detail,
    createdAt: iso(e.createdAt),
  }));
  return { items, total: num(total?.n), page: query.page, pageSize: query.pageSize };
};

/* ================================ Reglas ================================ */

const RULE_META: Record<
  string,
  {
    label: string;
    description: string;
    unit: string;
    financial: boolean;
    format: (v: number) => string;
  }
> = {
  MIN_NET_MARGIN_BPS: {
    label: 'Margen neto mínimo',
    description: 'Debajo de este margen un producto no es viable ni se publica.',
    unit: 'bps (100 = 1 %)',
    financial: true,
    format: String,
  },
  MAX_FUNDS_DATA_AGE_HOURS: {
    label: 'Antigüedad máxima del saldo',
    description: 'Un saldo más viejo no sirve para aprobar pedidos al proveedor.',
    unit: 'horas',
    financial: true,
    format: String,
  },
  MAX_RETURN_RISK_BPS: {
    label: 'Riesgo de devolución máximo',
    description: 'Por encima de este riesgo el Financial Guard bloquea.',
    unit: 'bps',
    financial: true,
    format: String,
  },
  MAX_PRICE_AGE_HOURS: {
    label: 'Antigüedad máxima del precio del proveedor',
    description: 'Un precio más viejo se considera desactualizado.',
    unit: 'horas',
    financial: false,
    format: String,
  },
  MAX_STOCK_AGE_HOURS: {
    label: 'Antigüedad máxima del control de stock',
    description: 'Un control más viejo no confirma stock.',
    unit: 'horas',
    financial: false,
    format: String,
  },
  COMMERCIAL_ACTIONS_ENABLED: {
    label: 'Acciones comerciales reales',
    description: 'Interruptor maestro: publicar, comprar, cobrar, reembolsar y contactar clientes.',
    unit: 'true / false',
    financial: true,
    format: (v) => (v ? 'true' : 'false'),
  },
};

export const listRules = (rt: CommandRuntime): RuleDto[] =>
  Object.entries(RULE_META).map(([key, m]) => {
    const raw = (rt.config as unknown as Record<string, number | boolean>)[key];
    return {
      key,
      label: m.label,
      description: m.description,
      value: typeof raw === 'boolean' ? String(raw) : m.format(Number(raw)),
      unit: m.unit,
      financial: m.financial,
      source: 'Variable de entorno (apps/api/wrangler.jsonc)',
    };
  });

const toRequestDto = (r: typeof ruleChangeRequests.$inferSelect): RuleChangeRequestDto => ({
  id: r.id,
  ruleKey: r.ruleKey,
  currentValue: r.currentValue,
  proposedValue: r.proposedValue,
  reason: r.reason,
  financial: r.financial,
  status: r.status,
  createdAt: iso(r.createdAt),
});

export const listRuleRequests = async (rt: CommandRuntime) =>
  (
    await rt.db
      .select()
      .from(ruleChangeRequests)
      .where(eq(ruleChangeRequests.tenantId, rt.tenantId))
      .orderBy(desc(ruleChangeRequests.createdAt))
      .limit(100)
  ).map(toRequestDto);

/**
 * Propuesta de cambio. NO aplica nada: las reglas viven en variables de entorno y
 * cambiarlas requiere autorización del titular (editar wrangler.jsonc y desplegar).
 */
export const proposeRuleChange = async (
  rt: CommandRuntime,
  input: CreateRuleChangeRequest,
): Promise<Result<RuleChangeRequestDto>> => {
  const rule = listRules(rt).find((r) => r.key === input.ruleKey);
  if (!rule) return notFound('Regla');
  if (
    input.ruleKey === 'COMMERCIAL_ACTIONS_ENABLED'
      ? !['true', 'false'].includes(input.proposedValue)
      : !/^\d{1,6}$/.test(input.proposedValue)
  )
    return err(appError('VALIDATION_ERROR', 'Valor propuesto inválido para esta regla'));
  if (input.proposedValue === rule.value)
    return err(appError('VALIDATION_ERROR', 'El valor propuesto es igual al actual'));
  const id = newId();
  await rt.db.insert(ruleChangeRequests).values({
    id,
    tenantId: rt.tenantId,
    ruleKey: rule.key,
    currentValue: rule.value,
    proposedValue: input.proposedValue,
    reason: input.reason,
    financial: rule.financial,
    status: 'PENDING_AUTHORIZATION',
    createdAt: rt.now,
    updatedAt: rt.now,
  });
  await rt.db.insert(auditEvents).values({
    id: newId(),
    tenantId: rt.tenantId,
    action: 'rules.change_proposed',
    entityType: 'rule',
    entityId: rule.key,
    metadata: { from: rule.value, to: input.proposedValue, financial: rule.financial },
    dryRun: true,
    createdAt: rt.now,
  });
  const row = await rt.db
    .select()
    .from(ruleChangeRequests)
    .where(eq(ruleChangeRequests.id, id))
    .get();
  return row ? ok(toRequestDto(row)) : notFound('Propuesta');
};

export const withdrawRuleRequest = async (
  rt: CommandRuntime,
  id: string,
): Promise<Result<RuleChangeRequestDto>> => {
  const rows = await rt.db
    .update(ruleChangeRequests)
    .set({ status: 'WITHDRAWN', updatedAt: rt.now })
    .where(
      and(
        eq(ruleChangeRequests.id, id),
        eq(ruleChangeRequests.tenantId, rt.tenantId),
        eq(ruleChangeRequests.status, 'PENDING_AUTHORIZATION'),
      ),
    )
    .returning();
  return rows[0] ? ok(toRequestDto(rows[0])) : notFound('Propuesta pendiente');
};

/* ================================ Configuración ================================ */

const SECRET_PURPOSE: Record<keyof ChannelSecrets, string> = {
  TOKEN_ENCRYPTION_KEY: 'Cifrado de tokens de integraciones',
  PUBLIC_API_URL: 'URL pública para callbacks OAuth',
  ML_APP_ID: 'App de Mercado Libre',
  ML_CLIENT_SECRET: 'App de Mercado Libre',
  INSTAGRAM_APP_ID: 'App de Instagram',
  INSTAGRAM_APP_SECRET: 'App de Instagram y firma de webhooks',
  META_APP_SECRET: 'Firma de webhooks de WhatsApp',
  META_WEBHOOK_VERIFY_TOKEN: 'Verificación de webhooks de Meta',
};

export const getSettings = async (
  rt: CommandRuntime,
  secrets: ChannelSecrets,
): Promise<Result<SettingsDto>> => {
  const tenant = await rt.db.select().from(tenants).where(eq(tenants.id, rt.tenantId)).get();
  if (!tenant) return notFound('Espacio');
  return ok({
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
    environment: rt.config.APP_ENV,
    apiVersion: API_VERSION,
    commercialActionsEnabled: rt.config.COMMERCIAL_ACTIONS_ENABLED,
    cronTriggers: CRON_TRIGGERS,
    secrets: (Object.keys(SECRET_PURPOSE) as (keyof ChannelSecrets)[]).map((name) => ({
      name,
      configured: Boolean(secrets[name]),
      purpose: SECRET_PURPOSE[name],
    })),
  });
};

export const updateSettings = async (rt: CommandRuntime, secrets: ChannelSecrets, name: string) => {
  await rt.db.update(tenants).set({ name, updatedAt: rt.now }).where(eq(tenants.id, rt.tenantId));
  return getSettings(rt, secrets);
};

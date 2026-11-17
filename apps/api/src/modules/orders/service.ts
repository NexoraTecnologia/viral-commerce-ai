import { and, desc, eq, gt, inArray, lt, max, sum } from 'drizzle-orm';
import {
  assertCommercialActionAllowed,
  buyerStatusText,
  calculateProfit,
  evaluateOrderFinance,
  isSupplierOperable,
  nextAutomaticStep,
  ORDER_TRANSITIONS,
  reconcileOrder,
  refundableCents,
  requirementsFor,
  selectSupplier,
  signedLedgerAmount,
  validateOrderTransition,
  type OrderFacts,
  type OrderFinanceResult,
  type SupplierCandidate,
  type SupplierSelection,
} from '@vc/business-rules';
import {
  channelConnections,
  channelOrders,
  fundsSnapshots,
  orderEvents,
  orderItems,
  orderLedgerEntries,
  orderPayments,
  orderReturns,
  orders,
  products,
  shipments,
  supplierOrders,
  supplierProducts,
  suppliers,
  type Database,
  type OrderRow,
} from '@vc/database';
import {
  appError,
  err,
  newId,
  ok,
  RecordPaymentRequestSchema,
  RequestDispatchRequestSchema,
  type ApiConfig,
  type CreateOrderRequest,
  type FinancialCheckDto,
  type FundsSnapshotDto,
  type OrderDetailDto,
  type OrderDto,
  type OrderState,
  type RecordFundsSnapshotRequest,
  type RecordLedgerEntryRequest,
  type RecordPaymentRequest,
  type RegisterShipmentRequest,
  type RequestDispatchRequest,
  type ResolveReviewRequest,
  type Result,
  type ShipmentEventRequest,
  type SupplierResponseRequest,
} from '@vc/shared';
import { iso, isoOrNull, notFound } from '../../http';
import { getLatestInventory, listProductCostRows, toCostComponent } from '../catalog/service';
import { listEvidence, toEvidenceFacts } from '../suppliers/service';

/**
 * ORDER + FULFILLMENT ENGINE (capa con I/O). Junta los hechos REGISTRADOS de un
 * pedido, le pregunta al motor puro (`@vc/business-rules`) el siguiente paso y
 * lo aplica con control de concurrencia. No ejecuta transacciones reales.
 */
export interface OrderRuntime {
  readonly db: Database;
  readonly tenantId: string;
  readonly config: ApiConfig;
  readonly now: Date;
}

type Actor = 'SYSTEM' | 'USER' | 'AGENT';
const HOUR = 3_600_000;
const ACTIVE_SUPPLIER_ORDER = ['SELECTED', 'REQUESTED', 'ACCEPTED'] as const;

/* ================================== Carga ================================== */

export const findOrder = (db: Database, tenantId: string, id: string) =>
  db
    .select()
    .from(orders)
    .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
    .get();

const loadAll = async (rt: OrderRuntime, order: OrderRow) => {
  const [items, payments, sOrders, ships, returns, ledger] = await Promise.all([
    rt.db.select().from(orderItems).where(eq(orderItems.orderId, order.id)),
    rt.db.select().from(orderPayments).where(eq(orderPayments.orderId, order.id)),
    rt.db
      .select()
      .from(supplierOrders)
      .where(eq(supplierOrders.orderId, order.id))
      .orderBy(desc(supplierOrders.createdAt)),
    rt.db
      .select()
      .from(shipments)
      .where(eq(shipments.orderId, order.id))
      .orderBy(desc(shipments.createdAt)),
    rt.db
      .select()
      .from(orderReturns)
      .where(eq(orderReturns.orderId, order.id))
      .orderBy(desc(orderReturns.requestedAt)),
    rt.db.select().from(orderLedgerEntries).where(eq(orderLedgerEntries.orderId, order.id)),
  ]);
  return { items, payments, sOrders, ships, returns, ledger };
};
type Loaded = Awaited<ReturnType<typeof loadAll>>;

/** Candidatos REALES: ofertas de proveedores para los productos del pedido. */
const loadCandidates = async (
  rt: OrderRuntime,
  productIds: string[],
): Promise<SupplierCandidate[]> => {
  if (productIds.length === 0) return [];
  const offers = await rt.db
    .select({ offer: supplierProducts, supplier: suppliers })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(supplierProducts.supplierId, suppliers.id))
    .where(
      and(
        eq(supplierProducts.tenantId, rt.tenantId),
        inArray(supplierProducts.productId, productIds),
      ),
    );
  const evidenceCache = new Map<string, boolean>();
  const out: SupplierCandidate[] = [];
  for (const { offer, supplier } of offers) {
    if (!offer.productId) continue;
    let operable = evidenceCache.get(supplier.id);
    if (operable === undefined) {
      operable = isSupplierOperable(
        supplier,
        toEvidenceFacts(await listEvidence(rt.db, rt.tenantId, supplier.id)),
        rt.now,
      );
      evidenceCache.set(supplier.id, operable);
    }
    const inv = await getLatestInventory(rt.db, rt.tenantId, offer.id);
    out.push({
      supplierProductId: offer.id,
      productId: offer.productId,
      supplierId: supplier.id,
      supplierName: supplier.tradeName ?? supplier.legalName,
      supplierOperable: operable,
      supplierScore: supplier.score,
      deliveryDaysMax: supplier.deliveryTimeDaysMax,
      currency: offer.currency,
      wholesaleCents: offer.wholesalePriceCents,
      priceAgeHours: (rt.now.getTime() - offer.priceUpdatedAt.getTime()) / HOUR,
      stock: inv
        ? {
            status: inv.stockStatus,
            quantity: inv.quantity,
            ageHours: (rt.now.getTime() - inv.checkedAt.getTime()) / HOUR,
          }
        : null,
    });
  }
  return out;
};

const SELECTION_STATES: readonly OrderState[] = [
  'PAYMENT_CONFIRMED',
  'BLOCKED_NO_STOCK',
  'BLOCKED_SUPPLIER',
  'SUPPLIER_STOCK_VERIFIED',
  'BLOCKED_CASHFLOW',
  'FINANCIAL_APPROVED',
  'MANUAL_REVIEW',
];

/**
 * Selección vigente: si hay un pedido al proveedor activo, es ese proveedor
 * (no se cambia a mitad de camino); si no, se recalcula con datos frescos.
 */
const currentSelection = async (
  rt: OrderRuntime,
  order: OrderRow,
  l: Loaded,
): Promise<SupplierSelection | null> => {
  if (!SELECTION_STATES.includes(order.state)) return null;
  const active = l.sOrders.find((s) =>
    (ACTIVE_SUPPLIER_ORDER as readonly string[]).includes(s.status),
  );
  if (active && active.status !== 'SELECTED') {
    // Costo unitario prorrateado del costo acordado (nunca 0: subestimaría costos).
    const units = l.items.reduce((a, i) => a + i.quantity, 0);
    const unitCost = units > 0 ? Math.ceil(active.costCents / units) : active.costCents;
    return {
      ok: true,
      supplierId: active.supplierId,
      supplierName: '',
      lines: l.items.map((i) => ({
        productId: i.productId,
        supplierProductId: i.supplierProductId ?? '',
        quantity: i.quantity,
        unitCostCents: unitCost,
      })),
      totalCostCents: active.costCents,
      rejected: [],
    };
  }
  return selectSupplier(
    l.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    await loadCandidates(rt, [...new Set(l.items.map((i) => i.productId))]),
    {
      currency: order.currency,
      maxStockAgeHours: rt.config.MAX_STOCK_AGE_HOURS,
      maxPriceAgeHours: rt.config.MAX_PRICE_AGE_HOURS,
    },
    order.excludedSupplierIds,
  );
};

const latestFunds = (rt: OrderRuntime, currency: 'ARS' | 'USD') =>
  rt.db
    .select()
    .from(fundsSnapshots)
    .where(and(eq(fundsSnapshots.tenantId, rt.tenantId), eq(fundsSnapshots.currency, currency)))
    .orderBy(desc(fundsSnapshots.asOf), desc(fundsSnapshots.recordedAt))
    .get();

/**
 * Fondos comprometidos: reservas de otros pedidos aprobados + pagos a
 * proveedores registrados DESPUÉS del último saldo (todavía no reflejados).
 */
const committedFunds = async (
  rt: OrderRuntime,
  exceptOrderId: string,
  currency: 'ARS' | 'USD',
  asOf: Date | null,
) => {
  const reserved = await rt.db
    .select({ total: sum(orders.reservedFundsCents) })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, rt.tenantId),
        eq(orders.currency, currency),
        gt(orders.reservedFundsCents, 0),
      ),
    )
    .get();
  const own = await findOrder(rt.db, rt.tenantId, exceptOrderId);
  let paidAfter = 0;
  if (asOf) {
    const rows = await rt.db
      .select({ total: sum(orderLedgerEntries.amountCents) })
      .from(orderLedgerEntries)
      .where(
        and(
          eq(orderLedgerEntries.tenantId, rt.tenantId),
          eq(orderLedgerEntries.type, 'SUPPLIER_COST'),
          eq(orderLedgerEntries.currency, currency),
          gt(orderLedgerEntries.occurredAt, asOf),
        ),
      )
      .get();
    paidAfter = Math.abs(Number(rows?.total ?? 0));
  }
  return Math.max(0, Number(reserved?.total ?? 0) - (own?.reservedFundsCents ?? 0)) + paidAfter;
};

const FINANCE_STATES: readonly OrderState[] = [
  'SUPPLIER_STOCK_VERIFIED',
  'BLOCKED_CASHFLOW',
  'MANUAL_REVIEW',
];

const evaluateFinance = async (
  rt: OrderRuntime,
  order: OrderRow,
  l: Loaded,
  selection: SupplierSelection | null,
): Promise<OrderFinanceResult | null> => {
  if (!selection?.ok) return null;
  const supplier = await rt.db
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, selection.supplierId))
    .get();
  if (!supplier) return null;
  const funds = await latestFunds(rt, order.currency);
  const items = [];
  for (const it of l.items) {
    const line = selection.lines.find((x) => x.productId === it.productId);
    items.push({
      unitPriceCents: it.unitPriceCents,
      quantity: it.quantity,
      unitCostCents: line?.unitCostCents ?? 0,
      components: (await listProductCostRows(rt.db, rt.tenantId, it.productId)).map(
        toCostComponent,
      ),
    });
  }
  return evaluateOrderFinance({
    totalCents: order.totalCents,
    supplierCostCents: selection.totalCostCents,
    items,
    funds: funds
      ? { availableCents: funds.availableCents, asOf: funds.asOf, source: funds.source }
      : null,
    committedCents: await committedFunds(rt, order.id, order.currency, funds?.asOf ?? null),
    supplier: {
      requiresPrepayment: supplier.requiresPrepayment,
      paymentDueDays: supplier.paymentDueDays,
    },
    expectedSettlementAt: order.expectedSettlementAt,
    policy: {
      maxFundsDataAgeHours: rt.config.MAX_FUNDS_DATA_AGE_HOURS,
      maxReturnRiskBps: rt.config.MAX_RETURN_RISK_BPS,
    },
    now: rt.now,
  });
};

/** Neto esperado por el Profit Engine con el costo real acordado con el proveedor. */
const expectedNet = async (rt: OrderRuntime, l: Loaded): Promise<number | null> => {
  const accepted = l.sOrders.find((s) => s.status === 'ACCEPTED');
  if (!accepted) return null;
  const totalUnits = l.items.reduce((a, i) => a + i.quantity, 0);
  let net = 0;
  for (const it of l.items) {
    const unitCost =
      totalUnits > 0
        ? Math.round((accepted.costCents * (it.quantity / totalUnits)) / it.quantity)
        : 0;
    const p = calculateProfit({
      salePriceCents: it.unitPriceCents,
      supplierCostCents: unitCost,
      components: (await listProductCostRows(rt.db, rt.tenantId, it.productId)).map(
        toCostComponent,
      ),
    });
    if (!p.ok) return null;
    net += p.value.netProfitCents * it.quantity;
  }
  return net;
};

const buildFacts = async (rt: OrderRuntime, order: OrderRow, l: Loaded) => {
  const selection = await currentSelection(rt, order, l);
  const finance = FINANCE_STATES.includes(order.state)
    ? await evaluateFinance(rt, order, l, selection)
    : null;
  const ship = l.ships[0];
  const so = l.sOrders.find((s) => s.status !== 'SELECTED') ?? null;
  const openReturn = l.returns.find((r) =>
    ['REQUESTED', 'APPROVED', 'RECEIVED'].includes(r.status),
  );
  const reconciliation = reconcileOrder(l.ledger, {
    currency: order.currency,
    expectedNetCents: await expectedNet(rt, l),
    supplierAccepted: l.sOrders.some((s) => s.status === 'ACCEPTED'),
  });
  const facts: OrderFacts = {
    state: order.state,
    totalCents: order.totalCents,
    currency: order.currency,
    payments: l.payments.map((p) => ({
      kind: p.kind,
      status: p.status,
      amountCents: p.amountCents,
      currency: p.currency,
      evidenceRef: p.evidenceRef,
    })),
    selection,
    financial: finance ? { decision: finance.decision, issues: finance.issues } : null,
    supplierOrder: so
      ? { supplierId: so.supplierId, status: so.status, confirmationRef: so.confirmationRef }
      : null,
    shipment: ship
      ? {
          status: ship.status,
          carrier: ship.carrier,
          trackingNumber: ship.trackingNumber,
          confirmationRef: ship.confirmationRef,
          estimatedDeliveryAt: ship.estimatedDeliveryAt,
          deliveryEvidenceRef: ship.deliveryEvidenceRef,
        }
      : null,
    openReturn: openReturn
      ? { status: openReturn.status as 'REQUESTED' | 'APPROVED' | 'RECEIVED' }
      : null,
    reconciliation: { status: reconciliation.status },
    now: rt.now,
  };
  return { facts, selection, finance, reconciliation };
};

/* ============================== Registro y transiciones ============================== */

const logEvent = (
  rt: OrderRuntime,
  orderId: string,
  type: string,
  actor: Actor,
  detail: Record<string, unknown>,
  from: OrderState | null = null,
  to: OrderState | null = null,
) =>
  rt.db.insert(orderEvents).values({
    id: newId(),
    tenantId: rt.tenantId,
    orderId,
    type,
    fromState: from,
    toState: to,
    actor,
    detail,
    createdAt: rt.now,
  });

/** Cambia el estado con compare-and-set y aplica efectos del estado destino. */
const applyTransition = async (
  rt: OrderRuntime,
  order: OrderRow,
  to: OrderState,
  reason: string,
  actor: Actor,
  ctx: { selection: SupplierSelection | null; finance: OrderFinanceResult | null; l: Loaded },
): Promise<boolean> => {
  const patch: Partial<typeof orders.$inferInsert> = {
    state: to,
    stateReason: reason,
    updatedAt: rt.now,
  };
  if (to === 'FINANCIAL_APPROVED' && ctx.finance)
    patch.reservedFundsCents = Math.max(
      ctx.finance.requiredFundsCents,
      ctx.finance.supplierCostCents,
    );
  if (
    [
      'CANCELLED',
      'REFUND_REQUIRED',
      'BLOCKED_SUPPLIER',
      'BLOCKED_NO_STOCK',
      'BLOCKED_CASHFLOW',
    ].includes(to)
  )
    patch.reservedFundsCents = 0;
  const failed = ctx.l.sOrders.find((s) => s.status === 'REJECTED' || s.status === 'NO_RESPONSE');
  if (to === 'BLOCKED_SUPPLIER' && failed && !order.excludedSupplierIds.includes(failed.supplierId))
    patch.excludedSupplierIds = [...order.excludedSupplierIds, failed.supplierId];

  const updated = await rt.db
    .update(orders)
    .set(patch)
    .where(and(eq(orders.id, order.id), eq(orders.state, order.state)))
    .returning({ id: orders.id });
  if (updated.length === 0) return false;

  if (to === 'SUPPLIER_STOCK_VERIFIED' && ctx.selection?.ok) {
    const sel = ctx.selection;
    // Anula selecciones previas no enviadas y registra la nueva.
    await rt.db
      .update(supplierOrders)
      .set({ status: 'CANCELLED', updatedAt: rt.now })
      .where(and(eq(supplierOrders.orderId, order.id), eq(supplierOrders.status, 'SELECTED')));
    await rt.db.insert(supplierOrders).values({
      id: newId(),
      tenantId: rt.tenantId,
      orderId: order.id,
      supplierId: sel.supplierId,
      status: 'SELECTED',
      costCents: sel.totalCostCents,
      currency: order.currency,
      createdAt: rt.now,
      updatedAt: rt.now,
    });
    for (const line of sel.lines) {
      await rt.db
        .update(orderItems)
        .set({ supplierProductId: line.supplierProductId })
        .where(and(eq(orderItems.orderId, order.id), eq(orderItems.productId, line.productId)));
    }
  }
  if (to === 'CANCELLED' || to === 'REFUND_REQUIRED') {
    await rt.db
      .update(supplierOrders)
      .set({ status: 'CANCELLED', updatedAt: rt.now })
      .where(
        and(
          eq(supplierOrders.orderId, order.id),
          inArray(supplierOrders.status, ['SELECTED', 'REQUESTED']),
        ),
      );
  }
  if (to === 'CANCELLED') {
    await rt.db
      .update(orderReturns)
      .set({ status: 'REFUNDED', updatedAt: rt.now })
      .where(and(eq(orderReturns.orderId, order.id), eq(orderReturns.status, 'RECEIVED')));
  }
  await logEvent(
    rt,
    order.id,
    'STATE_CHANGED',
    actor,
    {
      reason,
      ...(ctx.selection && !ctx.selection.ok ? { selection: ctx.selection } : {}),
      ...(ctx.selection?.ok && to === 'SUPPLIER_STOCK_VERIFIED'
        ? {
            supplierId: ctx.selection.supplierId,
            costCents: ctx.selection.totalCostCents,
            rejected: ctx.selection.rejected,
          }
        : {}),
      ...(ctx.finance && (to === 'FINANCIAL_APPROVED' || to === 'BLOCKED_CASHFLOW')
        ? { finance: ctx.finance }
        : {}),
    },
    order.state,
    to,
  );
  return true;
};

/** Corre el motor hasta que el pedido espere un evento externo o una decisión. */
export const advanceOrder = async (rt: OrderRuntime, id: string, actor: Actor = 'SYSTEM') => {
  for (let i = 0; i < 15; i++) {
    const order = await findOrder(rt.db, rt.tenantId, id);
    if (!order) return notFound('Pedido');
    const l = await loadAll(rt, order);
    const { facts, selection, finance } = await buildFacts(rt, order, l);
    const decision = nextAutomaticStep(facts);
    if (!decision) break;
    const applied = await applyTransition(rt, order, decision.to, decision.reason, actor, {
      selection,
      finance,
      l,
    });
    if (!applied) continue; // otro proceso lo cambió: se reevalúa
  }
  return getOrderDetail(rt, id);
};

/* ================================== DTOs ================================== */

const toOrderDto = (o: OrderRow, refunded: boolean): OrderDto => ({
  id: o.id,
  number: o.number,
  source: o.source,
  channelOrderId: o.channelOrderId,
  externalOrderId: o.externalOrderId,
  state: o.state,
  stateReason: o.stateReason,
  buyerRef: o.buyerRef,
  totalCents: o.totalCents,
  currency: o.currency,
  refunded,
  createdAt: iso(o.createdAt),
  updatedAt: iso(o.updatedAt),
});

export const getOrderDetail = async (
  rt: OrderRuntime,
  id: string,
): Promise<Result<OrderDetailDto>> => {
  const order = await findOrder(rt.db, rt.tenantId, id);
  if (!order) return notFound('Pedido');
  const l = await loadAll(rt, order);
  const { facts, finance, reconciliation } = await buildFacts(rt, order, l);
  const supplierNames = new Map(
    (
      await rt.db
        .select({ id: suppliers.id, legal: suppliers.legalName, trade: suppliers.tradeName })
        .from(suppliers)
        .where(eq(suppliers.tenantId, rt.tenantId))
    ).map((s) => [s.id, s.trade ?? s.legal]),
  );
  const events = await rt.db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, id))
    .orderBy(orderEvents.createdAt);
  const supplier = l.sOrders[0]
    ? await rt.db.select().from(suppliers).where(eq(suppliers.id, l.sOrders[0].supplierId)).get()
    : undefined;
  const refunded = l.payments.some((p) => p.kind === 'REFUND' && p.status === 'APPROVED');
  const financialCheck: FinancialCheckDto | null = finance
    ? {
        decision: finance.decision,
        issues: [...finance.issues],
        availableCents: finance.availableCents,
        committedCents: finance.committedCents,
        requiredFundsCents: finance.requiredFundsCents,
        supplierCostCents: finance.supplierCostCents,
        evaluatedAt: iso(rt.now),
      }
    : null;
  return ok({
    order: toOrderDto(order, refunded),
    items: l.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      title: i.title,
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
      supplierProductId: i.supplierProductId,
    })),
    payments: l.payments.map((p) => ({
      id: p.id,
      kind: p.kind,
      provider: p.provider,
      externalPaymentId: p.externalPaymentId,
      status: p.status,
      amountCents: p.amountCents,
      currency: p.currency,
      evidenceSource: p.evidenceSource,
      evidenceRef: p.evidenceRef,
      observedAt: iso(p.observedAt),
      recordedAt: iso(p.recordedAt),
    })),
    supplierOrders: l.sOrders.map((s) => ({
      id: s.id,
      supplierId: s.supplierId,
      supplierName: supplierNames.get(s.supplierId) ?? '—',
      status: s.status,
      costCents: s.costCents,
      currency: s.currency,
      requestRef: s.requestRef,
      requestedAt: isoOrNull(s.requestedAt),
      responseDueAt: isoOrNull(s.responseDueAt),
      confirmationRef: s.confirmationRef,
      confirmedAt: isoOrNull(s.confirmedAt),
      rejectionReason: s.rejectionReason,
      createdAt: iso(s.createdAt),
    })),
    shipments: l.ships.map((s) => ({
      id: s.id,
      carrier: s.carrier,
      trackingNumber: s.trackingNumber,
      trackingUrl: s.trackingUrl,
      status: s.status,
      confirmationSource: s.confirmationSource,
      confirmationRef: s.confirmationRef,
      shippedAt: iso(s.shippedAt),
      estimatedDeliveryAt: isoOrNull(s.estimatedDeliveryAt),
      deliveredAt: isoOrNull(s.deliveredAt),
      deliveryEvidenceRef: s.deliveryEvidenceRef,
    })),
    returns: l.returns.map((r) => ({
      id: r.id,
      status: r.status,
      reason: r.reason,
      decisionNote: r.decisionNote,
      receivedEvidenceRef: r.receivedEvidenceRef,
      requestedAt: iso(r.requestedAt),
      updatedAt: iso(r.updatedAt),
    })),
    ledger: l.ledger.map((e) => ({
      id: e.id,
      type: e.type,
      amountCents: e.amountCents,
      currency: e.currency,
      sourceRef: e.sourceRef,
      occurredAt: iso(e.occurredAt),
      recordedAt: iso(e.recordedAt),
    })),
    reconciliation,
    financialCheck,
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      fromState: e.fromState,
      toState: e.toState,
      actor: e.actor,
      detail: e.detail,
      createdAt: iso(e.createdAt),
    })),
    buyerStatus: buyerStatusText({
      orderNumber: order.number,
      order: facts,
      returnWindowDays: supplier?.returnWindowDays ?? null,
      deliveredAt: l.ships[0]?.deliveredAt ?? null,
    }),
    allowedTransitions: ORDER_TRANSITIONS[order.state].filter(
      (to) => requirementsFor(to, facts).length === 0,
    ),
  });
};

export const listOrders = async (rt: OrderRuntime, state?: OrderState): Promise<OrderDto[]> => {
  const rows = await rt.db
    .select()
    .from(orders)
    .where(
      state
        ? and(eq(orders.tenantId, rt.tenantId), eq(orders.state, state))
        : eq(orders.tenantId, rt.tenantId),
    )
    .orderBy(desc(orders.number))
    .limit(200);
  const refunded = new Set(
    (
      await rt.db
        .select({ orderId: orderPayments.orderId })
        .from(orderPayments)
        .where(
          and(
            eq(orderPayments.tenantId, rt.tenantId),
            eq(orderPayments.kind, 'REFUND'),
            eq(orderPayments.status, 'APPROVED'),
          ),
        )
    ).map((r) => r.orderId),
  );
  return rows.map((o) => toOrderDto(o, refunded.has(o.id)));
};

/* ================================ Recepción ================================ */

/**
 * Recepción de pedidos. Valida productos y moneda; si viene de un canal LIVE
 * pagado, registra como evidencia la orden informada por la API del canal.
 */
export const createOrder = async (
  rt: OrderRuntime,
  input: CreateOrderRequest,
): Promise<Result<OrderDetailDto>> => {
  const productIds = [...new Set(input.items.map((i) => i.productId))];
  const rows = await rt.db
    .select()
    .from(products)
    .where(and(eq(products.tenantId, rt.tenantId), inArray(products.id, productIds)));
  if (rows.length !== productIds.length) return notFound('Producto');
  if (rows.some((p) => p.currency !== input.currency))
    return err(
      appError('VALIDATION_ERROR', 'La moneda del pedido no coincide con la de los productos'),
    );
  const total = input.items.reduce((a, i) => a + i.unitPriceCents * i.quantity, 0);

  let channel: {
    order: typeof channelOrders.$inferSelect;
    mode: 'LIVE' | 'MOCK';
    channelName: string;
  } | null = null;
  if (input.channelOrderId) {
    const r = await rt.db
      .select({ order: channelOrders, conn: channelConnections })
      .from(channelOrders)
      .innerJoin(channelConnections, eq(channelOrders.connectionId, channelConnections.id))
      .where(
        and(eq(channelOrders.id, input.channelOrderId), eq(channelOrders.tenantId, rt.tenantId)),
      )
      .get();
    if (!r) return notFound('Pedido del canal');
    if (r.conn.mode === 'MOCK')
      return err(
        appError('CONFLICT', 'Un pedido de una conexión MOCK no se procesa como pedido real'),
      );
    channel = { order: r.order, mode: r.conn.mode, channelName: r.conn.channel };
    const dup = await rt.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.tenantId, rt.tenantId), eq(orders.channelOrderId, input.channelOrderId)))
      .get();
    if (dup)
      return err(appError('CONFLICT', 'Ese pedido del canal ya fue recibido', { orderId: dup.id }));
  }

  const last = await rt.db
    .select({ n: max(orders.number) })
    .from(orders)
    .where(eq(orders.tenantId, rt.tenantId))
    .get();
  const id = newId();
  await rt.db.insert(orders).values({
    id,
    tenantId: rt.tenantId,
    number: (last?.n ?? 1000) + 1,
    source: channel ? 'CHANNEL' : 'MANUAL',
    channelOrderId: input.channelOrderId ?? null,
    externalOrderId: input.externalOrderId ?? channel?.order.externalOrderId ?? null,
    buyerRef: input.buyerRef,
    currency: input.currency,
    totalCents: total,
    expectedSettlementAt: input.expectedSettlementAt ? new Date(input.expectedSettlementAt) : null,
    excludedSupplierIds: [],
    createdAt: rt.now,
    updatedAt: rt.now,
  });
  const titles = new Map(rows.map((p) => [p.id, p.title]));
  for (const it of input.items) {
    await rt.db.insert(orderItems).values({
      id: newId(),
      tenantId: rt.tenantId,
      orderId: id,
      productId: it.productId,
      title: titles.get(it.productId) ?? '',
      quantity: it.quantity,
      unitPriceCents: it.unitPriceCents,
    });
  }
  await logEvent(
    rt,
    id,
    'ORDER_RECEIVED',
    'USER',
    {
      source: channel ? 'CHANNEL' : 'MANUAL',
      items: input.items.length,
      totalCents: total,
    },
    null,
    'NEW',
  );

  if (channel?.order.status === 'PAID' && channel.order.totalCents !== null) {
    await recordPayment(
      rt,
      id,
      {
        provider: channel.channelName,
        externalPaymentId: `order:${channel.order.externalOrderId}`,
        status: 'APPROVED',
        amountCents: channel.order.totalCents,
        currency: input.currency,
        evidenceSource: 'CHANNEL_API',
        evidenceRef: `Orden ${channel.order.externalOrderId} informada "${channel.order.rawStatus}" por la API del canal (${iso(channel.order.syncedAt)})`,
        observedAt: iso(channel.order.syncedAt),
      },
      { advance: false },
    );
  }
  return advanceOrder(rt, id);
};

/* ================================ Pagos ================================ */

/** Registra un cobro o reembolso con evidencia. Idempotente por evento del canal de pago. */
export const recordPayment = async (
  rt: OrderRuntime,
  id: string,
  raw: RecordPaymentRequest,
  opts: { advance: boolean } = { advance: true },
): Promise<Result<OrderDetailDto>> => {
  const input = RecordPaymentRequestSchema.parse(raw);
  const order = await findOrder(rt.db, rt.tenantId, id);
  if (!order) return notFound('Pedido');
  if (new Date(input.observedAt).getTime() > rt.now.getTime() + 60_000)
    return err(appError('VALIDATION_ERROR', 'La evidencia no puede tener fecha futura'));
  if (input.currency !== order.currency)
    return err(appError('VALIDATION_ERROR', 'La moneda del pago no coincide con la del pedido'));
  if (input.kind === 'REFUND' && !['REFUND_REQUIRED', 'MANUAL_REVIEW'].includes(order.state))
    return err(
      appError('CONFLICT', 'Solo se registran reembolsos de pedidos con reintegro pendiente'),
    );
  const inserted = await rt.db
    .insert(orderPayments)
    .values({
      id: newId(),
      tenantId: rt.tenantId,
      orderId: id,
      kind: input.kind,
      provider: input.provider,
      externalPaymentId: input.externalPaymentId,
      status: input.status,
      amountCents: input.amountCents,
      currency: input.currency,
      evidenceSource: input.evidenceSource,
      evidenceRef: input.evidenceRef,
      observedAt: new Date(input.observedAt),
      recordedAt: rt.now,
    })
    .onConflictDoNothing()
    .returning({ id: orderPayments.id });
  if (inserted.length > 0) {
    await logEvent(
      rt,
      id,
      input.kind === 'REFUND' ? 'REFUND_RECORDED' : 'PAYMENT_RECORDED',
      'USER',
      {
        provider: input.provider,
        externalPaymentId: input.externalPaymentId,
        status: input.status,
        amountCents: input.amountCents,
        evidenceSource: input.evidenceSource,
      },
    );
    if (input.status === 'APPROVED') {
      const type = input.kind === 'REFUND' ? 'REFUND' : 'SALE';
      await rt.db.insert(orderLedgerEntries).values({
        id: newId(),
        tenantId: rt.tenantId,
        orderId: id,
        type,
        amountCents: signedLedgerAmount(type, input.amountCents),
        currency: input.currency,
        sourceRef: `${input.provider} ${input.externalPaymentId}: ${input.evidenceRef}`,
        occurredAt: new Date(input.observedAt),
        recordedAt: rt.now,
      });
    }
  }
  return opts.advance ? advanceOrder(rt, id) : getOrderDetail(rt, id);
};

/* ============================ Proveedor y despacho ============================ */

/**
 * Solicitud de despacho: es una ORDEN DE COMPRA al proveedor (acción comercial).
 * Con el interruptor apagado se bloquea y queda registrado. Cuando se habilite,
 * se registra la referencia del pedido enviado (no hay integración con proveedores).
 */
export const requestDispatch = async (
  rt: OrderRuntime,
  id: string,
  raw: RequestDispatchRequest,
): Promise<Result<OrderDetailDto>> => {
  const input = RequestDispatchRequestSchema.parse(raw);
  const order = await findOrder(rt.db, rt.tenantId, id);
  if (!order) return notFound('Pedido');
  if (order.state !== 'FINANCIAL_APPROVED')
    return err(
      appError('CONFLICT', 'Solo se solicita despacho con la validación financiera aprobada'),
    );
  const selected = await rt.db
    .select()
    .from(supplierOrders)
    .where(and(eq(supplierOrders.orderId, id), eq(supplierOrders.status, 'SELECTED')))
    .get();
  if (!selected)
    return err(appError('CONFLICT', 'No hay proveedor seleccionado pendiente de solicitud'));
  const guard = assertCommercialActionAllowed('place_supplier_order', {
    commercialActionsEnabled: rt.config.COMMERCIAL_ACTIONS_ENABLED,
  });
  if (!guard.ok) {
    await logEvent(rt, id, 'DISPATCH_BLOCKED', 'USER', {
      reason: guard.error.message,
      supplierId: selected.supplierId,
    });
    return guard;
  }
  await rt.db
    .update(supplierOrders)
    .set({
      status: 'REQUESTED',
      requestRef: input.requestRef,
      requestedAt: rt.now,
      responseDueAt: new Date(rt.now.getTime() + input.responseHours * HOUR),
      updatedAt: rt.now,
    })
    .where(eq(supplierOrders.id, selected.id));
  await logEvent(rt, id, 'DISPATCH_REQUESTED', 'USER', {
    supplierId: selected.supplierId,
    requestRef: input.requestRef,
    responseHours: input.responseHours,
  });
  return getOrderDetail(rt, id);
};

/** Respuesta del proveedor: aceptación SOLO con comprobante; rechazo con motivo. */
export const recordSupplierResponse = async (
  rt: OrderRuntime,
  id: string,
  input: SupplierResponseRequest,
): Promise<Result<OrderDetailDto>> => {
  const requested = await rt.db
    .select()
    .from(supplierOrders)
    .where(
      and(
        eq(supplierOrders.orderId, id),
        eq(supplierOrders.tenantId, rt.tenantId),
        eq(supplierOrders.status, 'REQUESTED'),
      ),
    )
    .get();
  if (!requested)
    return err(appError('CONFLICT', 'No hay una solicitud al proveedor esperando respuesta'));
  await rt.db
    .update(supplierOrders)
    .set(
      input.decision === 'ACCEPTED'
        ? {
            status: 'ACCEPTED',
            confirmationRef: input.confirmationRef,
            confirmedAt: rt.now,
            updatedAt: rt.now,
          }
        : { status: 'REJECTED', rejectionReason: input.reason, updatedAt: rt.now },
    )
    .where(eq(supplierOrders.id, requested.id));
  await logEvent(
    rt,
    id,
    input.decision === 'ACCEPTED' ? 'SUPPLIER_ACCEPTED' : 'SUPPLIER_REJECTED',
    'USER',
    {
      supplierId: requested.supplierId,
      ...(input.decision === 'ACCEPTED'
        ? { confirmationRef: input.confirmationRef }
        : { reason: input.reason }),
    },
  );
  return advanceOrder(rt, id);
};

/** Agente: solicitudes vencidas sin respuesta → NO_RESPONSE (el motor bloquea y excluye). */
export const scanSupplierTimeouts = async (rt: OrderRuntime) => {
  const overdue = await rt.db
    .select()
    .from(supplierOrders)
    .where(
      and(
        eq(supplierOrders.tenantId, rt.tenantId),
        eq(supplierOrders.status, 'REQUESTED'),
        lt(supplierOrders.responseDueAt, rt.now),
      ),
    )
    .limit(100);
  for (const so of overdue) {
    await rt.db
      .update(supplierOrders)
      .set({ status: 'NO_RESPONSE', updatedAt: rt.now })
      .where(and(eq(supplierOrders.id, so.id), eq(supplierOrders.status, 'REQUESTED')));
    await logEvent(rt, so.orderId, 'SUPPLIER_NO_RESPONSE', 'AGENT', {
      supplierId: so.supplierId,
      responseDueAt: isoOrNull(so.responseDueAt),
    });
    await advanceOrder(rt, so.orderId, 'AGENT');
  }
  return { marked: overdue.length };
};

/* ================================ Envíos ================================ */

/** Registro de transportista y seguimiento: sin comprobante no se informa "despachado". */
export const registerShipment = async (
  rt: OrderRuntime,
  id: string,
  input: RegisterShipmentRequest,
): Promise<Result<OrderDetailDto>> => {
  const order = await findOrder(rt.db, rt.tenantId, id);
  if (!order) return notFound('Pedido');
  if (order.state !== 'SUPPLIER_ORDER_ACCEPTED')
    return err(appError('CONFLICT', 'El envío se registra después de la aceptación del proveedor'));
  if (new Date(input.shippedAt).getTime() > rt.now.getTime() + 60_000)
    return err(appError('VALIDATION_ERROR', 'La fecha de despacho no puede ser futura'));
  const so = await rt.db
    .select()
    .from(supplierOrders)
    .where(and(eq(supplierOrders.orderId, id), eq(supplierOrders.status, 'ACCEPTED')))
    .get();
  await rt.db.insert(shipments).values({
    id: newId(),
    tenantId: rt.tenantId,
    orderId: id,
    supplierOrderId: so?.id ?? null,
    carrier: input.carrier,
    trackingNumber: input.trackingNumber,
    trackingUrl: input.trackingUrl ?? null,
    status: 'SHIPPED',
    confirmationSource: input.confirmationSource,
    confirmationRef: input.confirmationRef,
    shippedAt: new Date(input.shippedAt),
    estimatedDeliveryAt: input.estimatedDeliveryAt ? new Date(input.estimatedDeliveryAt) : null,
    createdAt: rt.now,
    updatedAt: rt.now,
  });
  await logEvent(rt, id, 'SHIPMENT_REGISTERED', 'USER', {
    carrier: input.carrier,
    trackingNumber: input.trackingNumber,
    confirmationSource: input.confirmationSource,
  });
  return advanceOrder(rt, id);
};

export const recordShipmentEvent = async (
  rt: OrderRuntime,
  id: string,
  input: ShipmentEventRequest,
): Promise<Result<OrderDetailDto>> => {
  const ship = await rt.db
    .select()
    .from(shipments)
    .where(and(eq(shipments.orderId, id), eq(shipments.tenantId, rt.tenantId)))
    .orderBy(desc(shipments.createdAt))
    .get();
  if (!ship) return err(appError('CONFLICT', 'El pedido no tiene envío registrado'));
  if (ship.status === 'DELIVERED' || ship.status === 'RETURNED')
    return err(appError('CONFLICT', `El envío ya está ${ship.status}`));
  if (new Date(input.occurredAt).getTime() > rt.now.getTime() + 60_000)
    return err(appError('VALIDATION_ERROR', 'La fecha del evento no puede ser futura'));
  await rt.db
    .update(shipments)
    .set(
      input.status === 'DELIVERED'
        ? {
            status: 'DELIVERED',
            deliveredAt: new Date(input.occurredAt),
            deliveryEvidenceRef: input.evidenceRef,
            updatedAt: rt.now,
          }
        : {
            status: 'DELAYED',
            ...(input.newEstimatedDeliveryAt
              ? { estimatedDeliveryAt: new Date(input.newEstimatedDeliveryAt) }
              : {}),
            updatedAt: rt.now,
          },
    )
    .where(eq(shipments.id, ship.id));
  await logEvent(
    rt,
    id,
    input.status === 'DELIVERED' ? 'SHIPMENT_DELIVERED' : 'SHIPMENT_DELAYED',
    'USER',
    {
      evidenceRef: input.evidenceRef,
      ...(input.newEstimatedDeliveryAt
        ? { newEstimatedDeliveryAt: input.newEstimatedDeliveryAt }
        : {}),
    },
  );
  return advanceOrder(rt, id);
};

/* ============================ Cancelaciones y devoluciones ============================ */

/**
 * Cancelación: sin cobro → CANCELLED; con cobro → REFUND_REQUIRED (el reembolso
 * se hace en el medio de pago y se registra con evidencia); si el proveedor ya
 * aceptó → MANUAL_REVIEW para anular con él.
 */
export const cancelOrder = async (
  rt: OrderRuntime,
  id: string,
  reason: string,
): Promise<Result<OrderDetailDto>> => {
  const order = await findOrder(rt.db, rt.tenantId, id);
  if (!order) return notFound('Pedido');
  const l = await loadAll(rt, order);
  const ctx = await buildFacts(rt, order, l);
  const target: OrderState =
    l.ships.length > 0
      ? 'MANUAL_REVIEW'
      : l.sOrders.some((s) => s.status === 'ACCEPTED')
        ? 'MANUAL_REVIEW'
        : refundableCents(ctx.facts) > 0
          ? 'REFUND_REQUIRED'
          : 'CANCELLED';
  if (l.ships.length > 0)
    return err(appError('CONFLICT', 'El pedido ya fue despachado: gestionalo como devolución'));
  const v = validateOrderTransition(order.state, target, ctx.facts);
  if (!v.ok) return v;
  await applyTransition(rt, order, target, `Cancelación solicitada: ${reason}`, 'USER', {
    ...ctx,
    l,
  });
  await logEvent(rt, id, 'CANCEL_REQUESTED', 'USER', { reason, resultingState: target });
  return advanceOrder(rt, id);
};

export const requestReturn = async (
  rt: OrderRuntime,
  id: string,
  reason: string,
): Promise<Result<OrderDetailDto>> => {
  const order = await findOrder(rt.db, rt.tenantId, id);
  if (!order) return notFound('Pedido');
  if (order.state !== 'DELIVERED')
    return err(appError('CONFLICT', 'Solo se solicita devolución de pedidos entregados'));
  const open = await rt.db
    .select({ id: orderReturns.id })
    .from(orderReturns)
    .where(
      and(
        eq(orderReturns.orderId, id),
        inArray(orderReturns.status, ['REQUESTED', 'APPROVED', 'RECEIVED']),
      ),
    )
    .get();
  if (open) return err(appError('CONFLICT', 'Ya hay una devolución abierta'));
  await rt.db.insert(orderReturns).values({
    id: newId(),
    tenantId: rt.tenantId,
    orderId: id,
    status: 'REQUESTED',
    reason,
    requestedAt: rt.now,
    updatedAt: rt.now,
  });
  await logEvent(rt, id, 'RETURN_REQUESTED', 'USER', { reason });
  return getOrderDetail(rt, id);
};

const openReturnOf = (rt: OrderRuntime, id: string, status: 'REQUESTED' | 'APPROVED') =>
  rt.db
    .select()
    .from(orderReturns)
    .where(
      and(
        eq(orderReturns.orderId, id),
        eq(orderReturns.tenantId, rt.tenantId),
        eq(orderReturns.status, status),
      ),
    )
    .get();

export const decideReturn = async (
  rt: OrderRuntime,
  id: string,
  decision: 'APPROVE' | 'REJECT',
  note: string,
): Promise<Result<OrderDetailDto>> => {
  const ret = await openReturnOf(rt, id, 'REQUESTED');
  if (!ret) return err(appError('CONFLICT', 'No hay devolución pendiente de decisión'));
  await rt.db
    .update(orderReturns)
    .set({
      status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      decisionNote: note,
      updatedAt: rt.now,
    })
    .where(eq(orderReturns.id, ret.id));
  await logEvent(rt, id, decision === 'APPROVE' ? 'RETURN_APPROVED' : 'RETURN_REJECTED', 'USER', {
    note,
  });
  return advanceOrder(rt, id);
};

/** Producto devuelto recibido (con comprobante) → el motor exige reintegro. */
export const receiveReturn = async (
  rt: OrderRuntime,
  id: string,
  evidenceRef: string,
): Promise<Result<OrderDetailDto>> => {
  const ret = await openReturnOf(rt, id, 'APPROVED');
  if (!ret) return err(appError('CONFLICT', 'No hay devolución aprobada esperando recepción'));
  await rt.db
    .update(orderReturns)
    .set({ status: 'RECEIVED', receivedEvidenceRef: evidenceRef, updatedAt: rt.now })
    .where(eq(orderReturns.id, ret.id));
  await rt.db
    .update(shipments)
    .set({ status: 'RETURNED', updatedAt: rt.now })
    .where(and(eq(shipments.orderId, id), eq(shipments.status, 'DELIVERED')));
  await logEvent(rt, id, 'RETURN_RECEIVED', 'USER', { evidenceRef });
  return advanceOrder(rt, id);
};

/** Intento de reembolso desde el sistema: acción comercial, siempre bloqueada aquí. */
export const requestRefundExecution = async (
  rt: OrderRuntime,
  id: string,
): Promise<Result<never>> => {
  const order = await findOrder(rt.db, rt.tenantId, id);
  if (!order) return notFound('Pedido');
  const guard = assertCommercialActionAllowed('refund_customer', {
    commercialActionsEnabled: rt.config.COMMERCIAL_ACTIONS_ENABLED,
  });
  await logEvent(rt, id, 'REFUND_EXECUTION_BLOCKED', 'USER', {
    reason: guard.ok
      ? 'Sin integración de pagos: el reembolso se hace en el medio de pago'
      : guard.error.message,
  });
  return err(
    guard.ok
      ? appError(
          'INTEGRATION_NOT_CONFIGURED',
          'No hay integración con el medio de pago: reembolsá desde el canal y registrá la evidencia',
        )
      : guard.error,
  );
};

/* ============================ Revisión manual ============================ */

/** Decisión humana: SIEMPRE sujeta a los mismos requisitos de evidencia. */
export const resolveReview = async (
  rt: OrderRuntime,
  id: string,
  input: ResolveReviewRequest,
): Promise<Result<OrderDetailDto>> => {
  const order = await findOrder(rt.db, rt.tenantId, id);
  if (!order) return notFound('Pedido');
  const l = await loadAll(rt, order);
  const ctx = await buildFacts(rt, order, l);
  const v = validateOrderTransition(order.state, input.to, ctx.facts);
  if (!v.ok) return v;
  await applyTransition(rt, order, input.to, `Decisión manual: ${input.reason}`, 'USER', {
    ...ctx,
    l,
  });
  return advanceOrder(rt, id);
};

/* ============================ Conciliación económica ============================ */

export const recordLedgerEntry = async (
  rt: OrderRuntime,
  id: string,
  input: RecordLedgerEntryRequest,
): Promise<Result<OrderDetailDto>> => {
  const order = await findOrder(rt.db, rt.tenantId, id);
  if (!order) return notFound('Pedido');
  if (input.currency !== order.currency)
    return err(appError('VALIDATION_ERROR', 'Moneda distinta a la del pedido: no se convierte'));
  if (new Date(input.occurredAt).getTime() > rt.now.getTime() + 60_000)
    return err(appError('VALIDATION_ERROR', 'La fecha del movimiento no puede ser futura'));
  if (input.type === 'SALE' || input.type === 'REFUND')
    return err(
      appError('VALIDATION_ERROR', 'Ventas y reembolsos se registran como pagos con evidencia'),
    );
  await rt.db.insert(orderLedgerEntries).values({
    id: newId(),
    tenantId: rt.tenantId,
    orderId: id,
    type: input.type,
    amountCents: signedLedgerAmount(input.type, input.amountCents),
    currency: input.currency,
    sourceRef: input.sourceRef,
    occurredAt: new Date(input.occurredAt),
    recordedAt: rt.now,
  });
  // El pago al proveedor libera la reserva de fondos del pedido.
  if (input.type === 'SUPPLIER_COST')
    await rt.db
      .update(orders)
      .set({ reservedFundsCents: 0, updatedAt: rt.now })
      .where(eq(orders.id, id));
  await logEvent(rt, id, 'LEDGER_ENTRY', 'USER', {
    type: input.type,
    amountCents: input.amountCents,
    sourceRef: input.sourceRef,
  });
  return advanceOrder(rt, id);
};

/* ================================ Fondos ================================ */

const toFundsDto = (f: typeof fundsSnapshots.$inferSelect): FundsSnapshotDto => ({
  id: f.id,
  availableCents: f.availableCents,
  currency: f.currency,
  asOf: iso(f.asOf),
  source: f.source,
  sourceRef: f.sourceRef,
  recordedAt: iso(f.recordedAt),
});

export const listFunds = async (rt: OrderRuntime) =>
  (
    await rt.db
      .select()
      .from(fundsSnapshots)
      .where(eq(fundsSnapshots.tenantId, rt.tenantId))
      .orderBy(desc(fundsSnapshots.asOf))
      .limit(50)
  ).map(toFundsDto);

/** Registra un saldo real (con comprobante) y reevalúa pedidos bloqueados por fondos. */
export const recordFunds = async (rt: OrderRuntime, input: RecordFundsSnapshotRequest) => {
  if (new Date(input.asOf).getTime() > rt.now.getTime() + 60_000)
    return err(appError('VALIDATION_ERROR', 'El saldo no puede tener fecha futura'));
  const row = await rt.db
    .insert(fundsSnapshots)
    .values({
      id: newId(),
      tenantId: rt.tenantId,
      availableCents: input.availableCents,
      currency: input.currency,
      asOf: new Date(input.asOf),
      source: input.source,
      sourceRef: input.sourceRef,
      recordedAt: rt.now,
    })
    .returning();
  const reevaluated = await reevaluateBlocked(rt, ['BLOCKED_CASHFLOW']);
  return row[0]
    ? ok({ snapshot: toFundsDto(row[0]), reevaluated })
    : err(appError('INTERNAL_ERROR', 'No se guardó'));
};

/** Agente: reevalúa pedidos bloqueados (stock, proveedor, fondos) y envíos sin entrega. */
export const reevaluateBlocked = async (
  rt: OrderRuntime,
  states: OrderState[] = [
    'PAYMENT_CONFIRMED',
    'BLOCKED_NO_STOCK',
    'BLOCKED_SUPPLIER',
    'BLOCKED_CASHFLOW',
    'SHIPPED',
  ],
) => {
  const rows = await rt.db
    .select({ id: orders.id, state: orders.state })
    .from(orders)
    .where(and(eq(orders.tenantId, rt.tenantId), inArray(orders.state, states)))
    .limit(100);
  let changed = 0;
  for (const r of rows) {
    const after = await advanceOrder(rt, r.id, 'AGENT');
    if (after.ok && after.value.order.state !== r.state) changed++;
  }
  return { evaluated: rows.length, changed };
};

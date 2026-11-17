import {
  appError,
  err,
  ok,
  type CostComponent,
  type Currency,
  type FinancialGuardIssue,
  type LedgerEntryType,
  type OrderState,
  type ReconciliationDto,
  type Result,
} from '@vc/shared';
import { evaluateFinancialGuard } from '../financial/financial-guard';
import { calculateProfit } from '../profit/calculate-profit';

/* ================================ Máquina de estados ================================ */

/**
 * Transiciones permitidas. Además de estar en la tabla, cada estado destino exige
 * su EVIDENCIA (ver `requirementsFor`): ni una persona puede saltear esas reglas.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  NEW: ['PAYMENT_PENDING', 'MANUAL_REVIEW', 'CANCELLED'],
  PAYMENT_PENDING: ['PAYMENT_CONFIRMED', 'MANUAL_REVIEW', 'CANCELLED'],
  PAYMENT_CONFIRMED: [
    'SUPPLIER_STOCK_VERIFIED',
    'BLOCKED_NO_STOCK',
    'BLOCKED_SUPPLIER',
    'MANUAL_REVIEW',
    'REFUND_REQUIRED',
  ],
  SUPPLIER_STOCK_VERIFIED: [
    'FINANCIAL_APPROVED',
    'BLOCKED_CASHFLOW',
    'MANUAL_REVIEW',
    'REFUND_REQUIRED',
  ],
  FINANCIAL_APPROVED: [
    'SUPPLIER_ORDER_ACCEPTED',
    'BLOCKED_SUPPLIER',
    'MANUAL_REVIEW',
    'REFUND_REQUIRED',
  ],
  SUPPLIER_ORDER_ACCEPTED: ['SHIPPED', 'BLOCKED_SUPPLIER', 'MANUAL_REVIEW'],
  SHIPPED: ['DELIVERED', 'MANUAL_REVIEW'],
  DELIVERED: ['SETTLED', 'REFUND_REQUIRED', 'MANUAL_REVIEW'],
  SETTLED: [],
  BLOCKED_NO_STOCK: [
    'SUPPLIER_STOCK_VERIFIED',
    'BLOCKED_SUPPLIER',
    'MANUAL_REVIEW',
    'REFUND_REQUIRED',
  ],
  BLOCKED_SUPPLIER: [
    'SUPPLIER_STOCK_VERIFIED',
    'BLOCKED_NO_STOCK',
    'MANUAL_REVIEW',
    'REFUND_REQUIRED',
  ],
  BLOCKED_CASHFLOW: ['FINANCIAL_APPROVED', 'MANUAL_REVIEW', 'REFUND_REQUIRED'],
  MANUAL_REVIEW: [
    'PAYMENT_PENDING',
    'PAYMENT_CONFIRMED',
    'SUPPLIER_STOCK_VERIFIED',
    'FINANCIAL_APPROVED',
    'SUPPLIER_ORDER_ACCEPTED',
    'SHIPPED',
    'DELIVERED',
    'REFUND_REQUIRED',
    'CANCELLED',
  ],
  REFUND_REQUIRED: ['CANCELLED', 'MANUAL_REVIEW'],
  CANCELLED: [],
};

export const isTerminal = (s: OrderState): boolean => ORDER_TRANSITIONS[s].length === 0;

/* ================================ Hechos del pedido ================================ */

export interface PaymentFact {
  readonly kind: 'CHARGE' | 'REFUND';
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED';
  readonly amountCents: number;
  readonly currency: Currency;
  readonly evidenceRef: string;
}

export interface SupplierOrderFact {
  readonly supplierId: string;
  readonly status: 'SELECTED' | 'REQUESTED' | 'ACCEPTED' | 'REJECTED' | 'NO_RESPONSE' | 'CANCELLED';
  readonly confirmationRef: string | null;
}

export interface ShipmentFact {
  readonly status: 'SHIPPED' | 'DELAYED' | 'DELIVERED' | 'RETURNED';
  readonly carrier: string;
  readonly trackingNumber: string;
  readonly confirmationRef: string;
  readonly estimatedDeliveryAt: Date | null;
  readonly deliveryEvidenceRef: string | null;
}

export interface OrderFacts {
  readonly state: OrderState;
  readonly totalCents: number;
  readonly currency: Currency;
  readonly payments: readonly PaymentFact[];
  /** Resultado de `selectSupplier` con datos frescos (null = no evaluado). */
  readonly selection: SupplierSelection | null;
  readonly financial: {
    readonly decision: 'APPROVED' | 'BLOCKED';
    readonly issues: readonly string[];
  } | null;
  /** Último pedido al proveedor vigente. */
  readonly supplierOrder: SupplierOrderFact | null;
  readonly shipment: ShipmentFact | null;
  readonly openReturn: { readonly status: 'REQUESTED' | 'APPROVED' | 'RECEIVED' } | null;
  readonly reconciliation: { readonly status: ReconciliationDto['status'] } | null;
  readonly now: Date;
}

const sumApproved = (f: OrderFacts, kind: 'CHARGE' | 'REFUND') =>
  f.payments
    .filter((p) => p.kind === kind && p.status === 'APPROVED' && p.currency === f.currency)
    .reduce((a, p) => a + p.amountCents, 0);

/** Pago confirmado = cobros APROBADOS con evidencia que cubren el total, en la misma moneda. */
export const isPaymentConfirmed = (f: OrderFacts): boolean =>
  f.payments.some(
    (p) => p.kind === 'CHARGE' && p.status === 'APPROVED' && p.evidenceRef.length >= 3,
  ) && sumApproved(f, 'CHARGE') >= f.totalCents;

/** Monto cobrado neto de reembolsos (lo que habría que devolver si se anula). */
export const refundableCents = (f: OrderFacts): number =>
  Math.max(0, sumApproved(f, 'CHARGE') - sumApproved(f, 'REFUND'));

export const isShipmentVerified = (s: ShipmentFact | null): boolean =>
  s !== null &&
  s.status !== 'RETURNED' &&
  s.carrier.length > 0 &&
  s.trackingNumber.length > 0 &&
  s.confirmationRef.length >= 3;

export const DELAY_REVIEW_HOURS = 72;

/**
 * Requisitos (evidencia) para ENTRAR a un estado. Lista vacía = permitido.
 * Implementa las reglas: sin evidencia de pago no hay pago confirmado; sin
 * fondos no se ordena al proveedor; sin confirmación verificable no hay envío.
 */
export const requirementsFor = (to: OrderState, f: OrderFacts): string[] => {
  const missing: string[] = [];
  switch (to) {
    case 'PAYMENT_CONFIRMED':
      if (!isPaymentConfirmed(f))
        missing.push('Falta evidencia del canal de pago de un cobro aprobado por el total');
      break;
    case 'SUPPLIER_STOCK_VERIFIED':
      if (!f.selection?.ok) missing.push('No hay proveedor verificado con stock confirmado');
      if (!isPaymentConfirmed(f)) missing.push('El pago no está confirmado');
      break;
    case 'FINANCIAL_APPROVED':
      if (f.financial?.decision !== 'APPROVED')
        missing.push('La validación financiera no aprobó (fondos o financiación insuficientes)');
      if (!f.selection?.ok) missing.push('No hay proveedor seleccionado con stock');
      break;
    case 'SUPPLIER_ORDER_ACCEPTED':
      if (
        f.supplierOrder?.status !== 'ACCEPTED' ||
        !f.supplierOrder.confirmationRef ||
        (f.selection?.ok === true && f.supplierOrder.supplierId !== f.selection.supplierId)
      )
        missing.push('Falta la confirmación verificable del proveedor');
      break;
    case 'SHIPPED':
      if (!isShipmentVerified(f.shipment))
        missing.push('Falta transportista, número de seguimiento o comprobante del despacho');
      break;
    case 'DELIVERED':
      if (f.shipment?.status !== 'DELIVERED' || !f.shipment.deliveryEvidenceRef)
        missing.push('Falta evidencia de entrega');
      break;
    case 'SETTLED':
      if (f.reconciliation?.status !== 'MATCHED')
        missing.push('La conciliación económica no cerró');
      if (f.openReturn) missing.push('Hay una devolución abierta');
      break;
    case 'REFUND_REQUIRED':
      if (refundableCents(f) <= 0) missing.push('No hay un cobro aprobado para reintegrar');
      break;
    case 'CANCELLED':
      if (refundableCents(f) > 0)
        missing.push('Hay dinero cobrado: primero debe registrarse el reembolso con evidencia');
      if (f.shipment && f.shipment.status !== 'RETURNED')
        missing.push('El pedido ya fue despachado: corresponde una devolución');
      if (!f.shipment && f.supplierOrder?.status === 'ACCEPTED')
        missing.push('El proveedor ya aceptó: primero hay que anular el pedido al proveedor');
      break;
    default:
      break;
  }
  return missing;
};

export const validateOrderTransition = (
  from: OrderState,
  to: OrderState,
  facts: OrderFacts,
): Result<void> => {
  if (!ORDER_TRANSITIONS[from].includes(to))
    return err(appError('CONFLICT', `Transición no permitida: ${from} → ${to}`));
  const missing = requirementsFor(to, facts);
  return missing.length === 0
    ? ok(undefined)
    : err(appError('CONFLICT', `No se cumplen los requisitos para ${to}`, { missing }));
};

export interface EngineDecision {
  readonly to: OrderState;
  readonly reason: string;
}

/**
 * Motor determinístico: dado el estado y los hechos, decide el siguiente paso
 * automático (o null si espera un evento externo / decisión humana).
 */
export const nextAutomaticStep = (f: OrderFacts): EngineDecision | null => {
  const go = (to: OrderState, reason: string): EngineDecision | null =>
    validateOrderTransition(f.state, to, f).ok ? { to, reason } : null;
  // Solo cuenta el pedido al proveedor del proveedor seleccionado ahora; uno
  // anterior (rechazado o sin respuesta) de otro proveedor no se reutiliza.
  const currentSupplierOrder =
    f.selection?.ok && f.supplierOrder?.supplierId === f.selection.supplierId
      ? f.supplierOrder
      : null;
  const failedSupplierId =
    f.supplierOrder && ['REJECTED', 'NO_RESPONSE', 'CANCELLED'].includes(f.supplierOrder.status)
      ? f.supplierOrder.supplierId
      : null;

  switch (f.state) {
    case 'NEW':
      return go('PAYMENT_PENDING', 'Pedido recibido y validado');
    case 'PAYMENT_PENDING': {
      if (isPaymentConfirmed(f))
        return go('PAYMENT_CONFIRMED', 'Pago aprobado con evidencia del canal');
      const charges = f.payments.filter((p) => p.kind === 'CHARGE');
      if (charges.length > 0 && charges.every((p) => p.status === 'REJECTED'))
        return go('CANCELLED', 'Pago rechazado por el canal de pago');
      return null;
    }
    case 'PAYMENT_CONFIRMED':
    case 'BLOCKED_NO_STOCK':
    case 'BLOCKED_SUPPLIER': {
      if (!f.selection) return null;
      if (f.selection.ok) {
        if (f.selection.supplierId === failedSupplierId) return null;
        return go('SUPPLIER_STOCK_VERIFIED', `Proveedor seleccionado: ${f.selection.supplierName}`);
      }
      const target = f.selection.reason === 'NO_STOCK' ? 'BLOCKED_NO_STOCK' : 'BLOCKED_SUPPLIER';
      return f.state === target ? null : go(target, f.selection.detail);
    }
    case 'SUPPLIER_STOCK_VERIFIED':
    case 'BLOCKED_CASHFLOW':
      if (!f.financial) return null;
      if (f.financial.decision === 'APPROVED')
        return go('FINANCIAL_APPROVED', 'Fondos disponibles para el proveedor');
      return f.state === 'BLOCKED_CASHFLOW'
        ? null
        : go('BLOCKED_CASHFLOW', `Bloqueo financiero: ${f.financial.issues.join(', ')}`);
    case 'FINANCIAL_APPROVED':
      if (currentSupplierOrder?.status === 'ACCEPTED')
        return go('SUPPLIER_ORDER_ACCEPTED', 'El proveedor confirmó el pedido');
      if (currentSupplierOrder?.status === 'REJECTED')
        return go('BLOCKED_SUPPLIER', 'El proveedor rechazó el pedido');
      if (currentSupplierOrder?.status === 'NO_RESPONSE')
        return go('BLOCKED_SUPPLIER', 'El proveedor no respondió en el plazo');
      return null;
    case 'SUPPLIER_ORDER_ACCEPTED':
      if (isShipmentVerified(f.shipment))
        return go('SHIPPED', 'Despacho confirmado con comprobante');
      if (f.supplierOrder?.status === 'CANCELLED')
        return go('BLOCKED_SUPPLIER', 'El proveedor canceló');
      return null;
    case 'SHIPPED': {
      if (f.shipment?.status === 'DELIVERED')
        return go('DELIVERED', 'Entrega confirmada con evidencia');
      const eta = f.shipment?.estimatedDeliveryAt;
      // Sin entrega confirmada 72 h después de lo estimado ⇒ revisión humana.
      // (No se marca "demorado" por cuenta propia: eso lo informa el transportista.)
      if (eta && f.now.getTime() - eta.getTime() > DELAY_REVIEW_HOURS * 3_600_000)
        return go(
          'MANUAL_REVIEW',
          `Sin entrega confirmada ${DELAY_REVIEW_HOURS} h después de la fecha estimada`,
        );
      return null;
    }
    case 'DELIVERED':
      if (f.openReturn?.status === 'RECEIVED') return go('REFUND_REQUIRED', 'Devolución recibida');
      if (f.reconciliation?.status === 'MISMATCH')
        return go('MANUAL_REVIEW', 'La conciliación económica no coincide');
      return go('SETTLED', 'Conciliación económica cerrada');
    case 'REFUND_REQUIRED':
      return go('CANCELLED', 'Reembolso acreditado con evidencia');
    default:
      return null;
  }
};

/* ================================ Selección de proveedor ================================ */

export interface SupplierCandidate {
  readonly supplierProductId: string;
  readonly productId: string;
  readonly supplierId: string;
  readonly supplierName: string;
  /** Verificado, con despacho directo y evidencia vigente (Supplier Engine). */
  readonly supplierOperable: boolean;
  readonly supplierScore: number;
  readonly deliveryDaysMax: number | null;
  readonly currency: Currency;
  readonly wholesaleCents: number;
  readonly priceAgeHours: number;
  readonly stock: {
    readonly status: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';
    readonly quantity: number | null;
    readonly ageHours: number;
  } | null;
}

export interface SelectionPolicy {
  readonly currency: Currency;
  readonly maxStockAgeHours: number;
  readonly maxPriceAgeHours: number;
}

export type SupplierSelection =
  | {
      readonly ok: true;
      readonly supplierId: string;
      readonly supplierName: string;
      readonly lines: readonly {
        productId: string;
        supplierProductId: string;
        quantity: number;
        unitCostCents: number;
      }[];
      readonly totalCostCents: number;
      readonly rejected: readonly { supplierId: string; reasons: string[] }[];
    }
  | {
      readonly ok: false;
      readonly reason: 'NO_STOCK' | 'NO_ELIGIBLE_SUPPLIER';
      readonly detail: string;
      readonly rejected: readonly { supplierId: string; reasons: string[] }[];
    };

/**
 * Elige UN proveedor que pueda despachar todos los ítems (un solo envío):
 * verificado y operable, precio vigente, misma moneda y stock CONFIRMADO con
 * cantidad suficiente. Desempate: menor costo, mayor puntaje, menor plazo.
 */
export const selectSupplier = (
  items: readonly { productId: string; quantity: number }[],
  candidates: readonly SupplierCandidate[],
  policy: SelectionPolicy,
  excludedSupplierIds: readonly string[] = [],
): SupplierSelection => {
  const bySupplier = new Map<string, SupplierCandidate[]>();
  for (const c of candidates)
    bySupplier.set(c.supplierId, [...(bySupplier.get(c.supplierId) ?? []), c]);

  const rejected: { supplierId: string; reasons: string[] }[] = [];
  const eligible: Extract<SupplierSelection, { ok: true }>[] = [];
  let sawStockShortage = false;

  for (const [supplierId, offers] of bySupplier) {
    const first = offers[0];
    if (!first) continue;
    const reasons: string[] = [];
    if (excludedSupplierIds.includes(supplierId)) reasons.push('Excluido (rechazó o no respondió)');
    if (!first.supplierOperable) reasons.push('Proveedor no verificado u operable');
    const lines: {
      productId: string;
      supplierProductId: string;
      quantity: number;
      unitCostCents: number;
    }[] = [];
    let stockProblem = false;
    let offersAll = true;
    for (const item of items) {
      const offer = offers
        .filter((o) => o.productId === item.productId && o.currency === policy.currency)
        .sort((a, b) => a.wholesaleCents - b.wholesaleCents)[0];
      if (!offer) {
        offersAll = false;
        reasons.push(`Sin oferta en ${policy.currency} para el producto ${item.productId}`);
        continue;
      }
      if (offer.priceAgeHours > policy.maxPriceAgeHours)
        reasons.push('Precio del proveedor desactualizado');
      const s = offer.stock;
      if (!s || s.status === 'UNKNOWN' || s.status === 'OUT_OF_STOCK') {
        stockProblem = true;
        reasons.push(`Sin stock confirmado (${s?.status ?? 'sin control'})`);
      } else if (s.ageHours > policy.maxStockAgeHours) {
        stockProblem = true;
        reasons.push(`Control de stock vencido (${Math.round(s.ageHours)} h)`);
      } else if (s.quantity === null || s.quantity < item.quantity) {
        stockProblem = true;
        reasons.push(
          s.quantity === null
            ? 'Cantidad disponible no informada'
            : `Stock insuficiente (${s.quantity} de ${item.quantity})`,
        );
      }
      lines.push({
        productId: item.productId,
        supplierProductId: offer.supplierProductId,
        quantity: item.quantity,
        unitCostCents: offer.wholesaleCents,
      });
    }
    if (
      first.supplierOperable &&
      offersAll &&
      stockProblem &&
      !excludedSupplierIds.includes(supplierId)
    )
      sawStockShortage = true;
    if (reasons.length > 0) {
      rejected.push({ supplierId, reasons });
      continue;
    }
    eligible.push({
      ok: true,
      supplierId,
      supplierName: first.supplierName,
      lines,
      totalCostCents: lines.reduce((a, l) => a + l.unitCostCents * l.quantity, 0),
      rejected: [],
    });
  }

  eligible.sort((a, b) => {
    if (a.totalCostCents !== b.totalCostCents) return a.totalCostCents - b.totalCostCents;
    const ca = bySupplier.get(a.supplierId)?.[0];
    const cb = bySupplier.get(b.supplierId)?.[0];
    const score = (cb?.supplierScore ?? 0) - (ca?.supplierScore ?? 0);
    if (score !== 0) return score;
    return (ca?.deliveryDaysMax ?? 999) - (cb?.deliveryDaysMax ?? 999);
  });
  const best = eligible[0];
  if (best) return { ...best, rejected };
  return sawStockShortage
    ? {
        ok: false,
        reason: 'NO_STOCK',
        detail: 'Ningún proveedor verificado tiene stock confirmado suficiente',
        rejected,
      }
    : {
        ok: false,
        reason: 'NO_ELIGIBLE_SUPPLIER',
        detail: 'No hay proveedor verificado que ofrezca todos los productos',
        rejected,
      };
};

/* ================================ Validación financiera ================================ */

export interface OrderFinanceInput {
  readonly totalCents: number;
  readonly supplierCostCents: number;
  /** Componentes de costo por ítem (Profit Engine) para estimar el resto de los costos. */
  readonly items: readonly {
    readonly unitPriceCents: number;
    readonly quantity: number;
    readonly components: readonly CostComponent[];
    readonly unitCostCents: number;
  }[];
  readonly funds: {
    readonly availableCents: number;
    readonly asOf: Date;
    readonly source: 'MANUAL' | 'SUPPLIER_REPORT' | 'INTEGRATION';
  } | null;
  /** Fondos ya comprometidos por otros pedidos aprobados y aún no reflejados en el saldo. */
  readonly committedCents: number;
  readonly supplier: {
    readonly requiresPrepayment: boolean;
    readonly paymentDueDays: number | null;
  };
  /** Liquidación informada por el canal; si falta se asume lo más conservador. */
  readonly expectedSettlementAt: Date | null;
  readonly policy: { readonly maxFundsDataAgeHours: number; readonly maxReturnRiskBps: number };
  readonly now: Date;
}

export interface OrderFinanceResult {
  readonly decision: 'APPROVED' | 'BLOCKED';
  readonly issues: readonly (FinancialGuardIssue | 'NO_FUNDS_DATA' | 'COST_DATA_INVALID')[];
  readonly availableCents: number | null;
  readonly committedCents: number;
  readonly requiredFundsCents: number;
  readonly supplierCostCents: number;
  readonly totalCostsCents: number;
}

/**
 * Nunca ordenar si requiere dinero no disponible: reutiliza el Financial Guard
 * con el saldo REGISTRADO menos lo ya comprometido. Sin dato de fondos ⇒ bloqueo.
 * Si el canal no informa la fecha de liquidación, se asume que liquida DESPUÉS
 * de pagar al proveedor (caso más exigente).
 */
export const evaluateOrderFinance = (input: OrderFinanceInput): OrderFinanceResult => {
  let totalCosts = 0;
  let returnRiskBps = 0;
  let invalidCosts = false;
  for (const it of input.items) {
    const p = calculateProfit({
      salePriceCents: it.unitPriceCents,
      supplierCostCents: it.unitCostCents,
      components: it.components,
    });
    // Fail-closed: si los costos no se pueden calcular, no se subestiman.
    if (!p.ok) invalidCosts = true;
    totalCosts += (p.ok ? p.value.totalCostsCents : it.unitCostCents) * it.quantity;
    const rr = it.components.find((c) => c.kind === 'RETURN_RESERVE')?.rateBps ?? 0;
    returnRiskBps = Math.max(returnRiskBps, rr);
  }
  if (invalidCosts) {
    return {
      decision: 'BLOCKED',
      issues: ['COST_DATA_INVALID'],
      availableCents: null,
      committedCents: input.committedCents,
      requiredFundsCents: input.supplierCostCents,
      supplierCostCents: input.supplierCostCents,
      totalCostsCents: totalCosts,
    };
  }
  if (!input.funds) {
    return {
      decision: 'BLOCKED',
      issues: ['NO_FUNDS_DATA'],
      availableCents: null,
      committedCents: input.committedCents,
      requiredFundsCents: input.supplierCostCents,
      supplierCostCents: input.supplierCostCents,
      totalCostsCents: totalCosts,
    };
  }
  const dueDays = input.supplier.requiresPrepayment ? 0 : (input.supplier.paymentDueDays ?? 0);
  const supplierDue = new Date(input.now.getTime() + dueDays * 86_400_000);
  const settlement = input.expectedSettlementAt ?? new Date(supplierDue.getTime() + 86_400_000);
  const available = Math.max(0, input.funds.availableCents - input.committedCents);
  const guard = evaluateFinancialGuard(
    {
      availableFundsCents: available,
      fundsAsOf: input.funds.asOf.toISOString(),
      fundsSource: input.funds.source,
      totalCostsCents: totalCosts,
      expectedSettlementCents: input.totalCents,
      channelSettlementDate: settlement.toISOString(),
      supplierPaymentDueDate: supplierDue.toISOString(),
      returnRiskBps,
      financing: null,
    },
    input.policy,
    input.now,
  );
  return {
    decision: guard.decision,
    issues: guard.issues,
    availableCents: available,
    committedCents: input.committedCents,
    requiredFundsCents: guard.requiredFundsCents,
    supplierCostCents: input.supplierCostCents,
    totalCostsCents: totalCosts,
  };
};

/* ================================ Conciliación ================================ */

export interface LedgerFact {
  readonly type: LedgerEntryType;
  /** Con signo: + ingreso, − egreso. */
  readonly amountCents: number;
  readonly currency: Currency;
}

/** Signo por tipo: ingresos positivos, costos y reembolsos negativos. */
export const signedLedgerAmount = (type: LedgerEntryType, amount: number): number =>
  type === 'SALE' ? Math.abs(amount) : type === 'ADJUSTMENT' ? amount : -Math.abs(amount);

export const RECONCILIATION_TOLERANCE = { bps: 100, minCents: 100 } as const;

/**
 * Conciliación económica: compara lo REGISTRADO (con comprobante) contra el neto
 * esperado por el Profit Engine. Sin venta o sin costo del proveedor no cierra.
 */
export const reconcileOrder = (
  ledger: readonly LedgerFact[],
  opts: {
    readonly currency: Currency;
    readonly expectedNetCents: number | null;
    readonly supplierAccepted: boolean;
  },
): ReconciliationDto => {
  const notes: string[] = [];
  const missing: string[] = [];
  const foreign = ledger.filter((l) => l.currency !== opts.currency);
  const same = ledger.filter((l) => l.currency === opts.currency);
  const revenue = same.filter((l) => l.type === 'SALE').reduce((a, l) => a + l.amountCents, 0);
  const refunds = same.filter((l) => l.type === 'REFUND').reduce((a, l) => a + l.amountCents, 0);
  const costs = same
    .filter((l) => l.type !== 'SALE' && l.type !== 'REFUND')
    .reduce((a, l) => a + l.amountCents, 0);
  const net = revenue + refunds + costs;
  if (!same.some((l) => l.type === 'SALE')) missing.push('SALE');
  if (opts.supplierAccepted && !same.some((l) => l.type === 'SUPPLIER_COST'))
    missing.push('SUPPLIER_COST');
  if (opts.expectedNetCents === null) missing.push('EXPECTED_NET');
  if (foreign.length > 0) notes.push('Hay movimientos en otra moneda: no se convierten');

  const diff = opts.expectedNetCents === null ? null : net - opts.expectedNetCents;
  const tolerance = Math.max(
    RECONCILIATION_TOLERANCE.minCents,
    Math.ceil((Math.abs(revenue) * RECONCILIATION_TOLERANCE.bps) / 10_000),
  );
  const status: ReconciliationDto['status'] =
    missing.length > 0
      ? 'PENDING_DATA'
      : foreign.length > 0 || (diff !== null && Math.abs(diff) > tolerance)
        ? 'MISMATCH'
        : 'MATCHED';
  if (status === 'MISMATCH' && diff !== null)
    notes.push(`Diferencia fuera de tolerancia (±${tolerance} centavos)`);
  return {
    status,
    currency: opts.currency,
    revenueCents: revenue,
    costsCents: costs,
    refundsCents: refunds,
    netCents: net,
    expectedNetCents: opts.expectedNetCents,
    differenceCents: diff,
    missing,
    notes,
  };
};

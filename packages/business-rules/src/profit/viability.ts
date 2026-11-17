import type {
  CostComponent,
  Currency,
  ProfitBreakdown,
  ProfitStatus,
  Result,
  StockStatus,
  SupplierStatus,
  ViabilityIssue,
} from '@vc/shared';
import { err, ok } from '@vc/shared';
import { isSupplierOperable, type EvidenceFact } from '../supplier/verification';
import { calculateProfit } from './calculate-profit';

export interface ViabilityPolicy {
  readonly minMarginBps: number;
  readonly maxPriceAgeHours: number;
  readonly maxStockAgeHours: number;
}

export interface ViabilityInput {
  readonly supplier: {
    readonly status: SupplierStatus;
    readonly directDispatch: boolean;
  };
  readonly evidence: readonly EvidenceFact[];
  readonly offer: {
    readonly wholesalePriceCents: number;
    readonly currency: Currency;
    readonly priceUpdatedAt: Date;
  };
  /** Último control de stock; null si nunca se registró. */
  readonly inventory: { readonly stockStatus: StockStatus; readonly checkedAt: Date } | null;
  readonly product: { readonly salePriceCents: number; readonly currency: Currency };
  readonly components: readonly CostComponent[];
  readonly policy: ViabilityPolicy;
  /** Se inyecta para mantener la función pura y testeable. */
  readonly now: Date;
}

export interface ViabilityResult {
  readonly status: ProfitStatus;
  readonly issues: readonly ViabilityIssue[];
  readonly breakdown: ProfitBreakdown | null;
}

const HOUR_MS = 3_600_000;

/**
 * Evalúa si un producto puede operarse con una oferta de proveedor.
 * Junta TODOS los problemas (no corta en el primero) para mostrarlos juntos.
 * Cualquier problema no económico ⇒ BLOCKED.
 */
export const evaluateViability = (input: ViabilityInput): Result<ViabilityResult> => {
  const { supplier, evidence, offer, inventory, product, policy, now } = input;
  const issues: ViabilityIssue[] = [];

  if (supplier.status !== 'VERIFIED') {
    issues.push('SUPPLIER_NOT_VERIFIED');
  } else if (!isSupplierOperable(supplier, evidence, now)) {
    issues.push(
      supplier.directDispatch ? 'SUPPLIER_EVIDENCE_EXPIRED' : 'SUPPLIER_NO_DIRECT_DISPATCH',
    );
  }

  if (inventory === null || inventory.stockStatus === 'UNKNOWN') {
    issues.push('STOCK_UNKNOWN');
  } else {
    if (inventory.stockStatus === 'OUT_OF_STOCK') issues.push('OUT_OF_STOCK');
    if (now.getTime() - inventory.checkedAt.getTime() > policy.maxStockAgeHours * HOUR_MS) {
      issues.push('STOCK_STALE');
    }
  }

  if (now.getTime() - offer.priceUpdatedAt.getTime() > policy.maxPriceAgeHours * HOUR_MS) {
    issues.push('PRICE_STALE');
  }

  if (offer.currency !== product.currency) {
    // No se inventan tipos de cambio: sin cotización explícita no hay cálculo.
    issues.push('CURRENCY_MISMATCH');
    return ok({ status: 'BLOCKED', issues, breakdown: null });
  }

  const profit = calculateProfit({
    salePriceCents: product.salePriceCents,
    supplierCostCents: offer.wholesalePriceCents,
    components: input.components,
    minMarginBps: policy.minMarginBps,
  });
  if (!profit.ok) return err(profit.error);

  const breakdown = profit.value;
  if (breakdown.status === 'NEGATIVE_MARGIN') issues.push('NEGATIVE_MARGIN');
  if (breakdown.status === 'BELOW_MIN_MARGIN') issues.push('BELOW_MIN_MARGIN');

  const blocking = issues.some((i) => i !== 'NEGATIVE_MARGIN' && i !== 'BELOW_MIN_MARGIN');
  return ok({ status: blocking ? 'BLOCKED' : breakdown.status, issues, breakdown });
};

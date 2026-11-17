import {
  appError,
  err,
  ok,
  type CostComponent,
  type CostComponentKind,
  type ProfitBreakdown,
  type ProfitLine,
  type Result,
} from '@vc/shared';

const BPS = 10_000;

/** Umbral inicial de margen neto: 20 %. Configurable vía MIN_NET_MARGIN_BPS. */
export const DEFAULT_MIN_MARGIN_BPS = 2_000;

export interface ProfitInput {
  /** Precio final cobrado al comprador, en centavos. */
  readonly salePriceCents: number;
  /** Precio mayorista del proveedor, en centavos (misma moneda). */
  readonly supplierCostCents: number;
  /**
   * Envío, comisiones, impuestos, retenciones, costos de cobro, reserva de
   * devoluciones y otros. Los porcentajes se aplican sobre el precio de venta.
   */
  readonly components: readonly CostComponent[];
  readonly minMarginBps?: number | undefined;
}

const isNonNegInt = (n: number | undefined): boolean =>
  n === undefined || (Number.isSafeInteger(n) && n >= 0);

/** Monto de un componente: fijo + ceil(precio × tasa). Redondeo conservador (hacia más costo). */
const componentAmount = (salePriceCents: number, c: CostComponent): number =>
  (c.fixedCents ?? 0) + (c.rateBps ? Math.ceil((salePriceCents * c.rateBps) / BPS) : 0);

const sumKind = (lines: readonly ProfitLine[], kind: CostComponentKind): number =>
  lines.filter((l) => l.kind === kind).reduce((acc, l) => acc + l.amountCents, 0);

/**
 * FUNCIÓN PURA de cálculo económico. Sin I/O, sin fecha actual, sin estado.
 *
 * beneficioNeto = precio − costoProveedor − Σ componentes
 * margen        = beneficioNeto / precio   (en bps, redondeado hacia abajo)
 *
 * Las retenciones se tratan como costo (criterio conservador de caja), aunque
 * fiscalmente puedan computarse luego a cuenta de impuestos.
 */
export const calculateProfit = (input: ProfitInput): Result<ProfitBreakdown> => {
  const minMarginBps = input.minMarginBps ?? DEFAULT_MIN_MARGIN_BPS;
  const { salePriceCents, supplierCostCents, components } = input;

  if (!Number.isSafeInteger(salePriceCents) || salePriceCents <= 0) {
    return err(appError('VALIDATION_ERROR', 'El precio de venta debe ser un entero positivo'));
  }
  if (!isNonNegInt(supplierCostCents) || !isNonNegInt(minMarginBps) || minMarginBps >= BPS) {
    return err(appError('VALIDATION_ERROR', 'Costo o margen mínimo inválido'));
  }
  for (const c of components) {
    if (!isNonNegInt(c.fixedCents) || !isNonNegInt(c.rateBps) || (c.rateBps ?? 0) > BPS) {
      return err(appError('VALIDATION_ERROR', `Componente de costo inválido: ${c.name}`));
    }
  }

  const lines: ProfitLine[] = [
    { kind: 'SUPPLIER_COST', name: 'Costo del proveedor', amountCents: supplierCostCents },
    ...components.map((c) => ({
      kind: c.kind,
      name: c.name,
      amountCents: componentAmount(salePriceCents, c),
    })),
  ];

  const totalCostsCents = lines.reduce((acc, l) => acc + l.amountCents, 0);
  const netProfitCents = salePriceCents - totalCostsCents;
  const marginBps = Math.floor((netProfitCents * BPS) / salePriceCents);

  const status =
    netProfitCents < 0
      ? 'NEGATIVE_MARGIN'
      : marginBps < minMarginBps
        ? 'BELOW_MIN_MARGIN'
        : 'PROFITABLE';

  return ok({
    salePriceCents,
    supplierCostCents,
    shippingCents: sumKind(lines, 'SHIPPING'),
    commissionsCents: sumKind(lines, 'CHANNEL_COMMISSION'),
    paymentProcessingCents: sumKind(lines, 'PAYMENT_PROCESSING'),
    taxesCents: sumKind(lines, 'TAX'),
    withholdingsCents: sumKind(lines, 'WITHHOLDING'),
    returnReserveCents: sumKind(lines, 'RETURN_RESERVE'),
    otherCostsCents: sumKind(lines, 'OTHER'),
    totalCostsCents,
    netProfitCents,
    marginBps,
    minMarginBps,
    status,
    lines,
  });
};

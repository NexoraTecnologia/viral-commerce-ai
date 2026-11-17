import { appError, err, ok, type Result } from '@vc/shared';

/**
 * Reglas de precio genéricas para un producto sin inventario propio.
 * Porcentajes en "basis points" (1 bp = 0,01 %; 10_000 bp = 100 %) y montos en
 * centavos enteros. NO incluye impuestos argentinos específicos: se agregarán
 * cuando estén definidos en las especificaciones funcionales.
 */
export interface PricingInput {
  /** Costo del proveedor por unidad, en centavos. */
  readonly supplierCostCents: number;
  /** Costo de envío absorbido por el vendedor, en centavos. */
  readonly shippingCostCents: number;
  /** Comisión porcentual del canal de venta / pasarela, en bp, sobre el precio final. */
  readonly channelFeeBps: number;
  /** Margen neto objetivo, en bp, sobre el precio final. */
  readonly targetMarginBps: number;
}

export interface PricingBreakdown {
  readonly salePriceCents: number;
  readonly channelFeeCents: number;
  readonly netProfitCents: number;
  readonly effectiveMarginBps: number;
}

const BPS = 10_000;

const isNonNegativeInt = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/**
 * Calcula el precio de venta mínimo que cumple el margen objetivo:
 *   precio = costoTotal / (1 - fee - margen)
 * Redondea hacia arriba al centavo para nunca quedar por debajo del margen.
 */
export const calculateSalePrice = (input: PricingInput): Result<PricingBreakdown> => {
  const { supplierCostCents, shippingCostCents, channelFeeBps, targetMarginBps } = input;

  if (
    ![supplierCostCents, shippingCostCents, channelFeeBps, targetMarginBps].every(isNonNegativeInt)
  ) {
    return err(appError('VALIDATION_ERROR', 'Todos los valores deben ser enteros no negativos'));
  }
  if (channelFeeBps + targetMarginBps >= BPS) {
    return err(
      appError('VALIDATION_ERROR', 'La suma de comisión y margen debe ser menor al 100 %'),
    );
  }

  const totalCostCents = supplierCostCents + shippingCostCents;
  const salePriceCents = Math.ceil(
    (totalCostCents * BPS) / (BPS - channelFeeBps - targetMarginBps),
  );
  const channelFeeCents = Math.ceil((salePriceCents * channelFeeBps) / BPS);
  const netProfitCents = salePriceCents - channelFeeCents - totalCostCents;
  const effectiveMarginBps =
    salePriceCents === 0 ? 0 : Math.floor((netProfitCents * BPS) / salePriceCents);

  return ok({ salePriceCents, channelFeeCents, netProfitCents, effectiveMarginBps });
};

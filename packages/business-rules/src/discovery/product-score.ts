import type { ProductScore, ScoreComponent, StockStatus, TrendDirection } from '@vc/shared';

export interface ProductScoreInput {
  /** Margen neto del último cálculo de rentabilidad; null si no hay cálculo. */
  readonly marginBps: number | null;
  readonly minMarginBps: number;
  /** Puntaje del proveedor vinculado (0–100); null si no hay proveedor. */
  readonly supplierScore: number | null;
  readonly stock: {
    readonly status: StockStatus;
    readonly ageHours: number;
    readonly maxAgeHours: number;
  } | null;
  /** null si no hay observaciones de precio de competidores. */
  readonly competitorCount: number | null;
  readonly trend: TrendDirection;
  readonly logistics: {
    readonly deliveryDaysMax: number | null;
    readonly trackingAvailable: boolean;
  } | null;
}

/** Pesos (suman 100). */
export const SCORE_WEIGHTS = {
  PROFITABILITY: 25,
  SUPPLIER_RELIABILITY: 20,
  AVAILABILITY: 15,
  COMPETITION: 15,
  DEMAND: 15,
  LOGISTICS: 10,
} as const;

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Puntuación comercial 0–100. Cada componente sin datos queda en `null` y aporta 0:
 * la falta de datos baja el puntaje y la confianza, nunca se completa con supuestos.
 *
 * IMPORTANTE: la puntuación es informativa. No interviene en Risk Guardian, que es
 * quien decide si un producto puede avanzar.
 */
export const computeProductScore = (i: ProductScoreInput): ProductScore => {
  const profitability: ScoreComponent =
    i.marginBps === null
      ? {
          name: 'PROFITABILITY',
          weight: SCORE_WEIGHTS.PROFITABILITY,
          value: null,
          basis: 'Sin cálculo de rentabilidad',
        }
      : {
          name: 'PROFITABILITY',
          weight: SCORE_WEIGHTS.PROFITABILITY,
          value:
            i.marginBps <= 0 ? 0 : clamp((i.marginBps / (2 * Math.max(1, i.minMarginBps))) * 100),
          basis: `Margen neto ${i.marginBps / 100} % (100 pts = el doble del mínimo)`,
        };

  const supplier: ScoreComponent = {
    name: 'SUPPLIER_RELIABILITY',
    weight: SCORE_WEIGHTS.SUPPLIER_RELIABILITY,
    value: i.supplierScore === null ? null : clamp(i.supplierScore),
    basis: i.supplierScore === null ? 'Sin proveedor vinculado' : 'Puntaje del Supplier Engine',
  };

  let availabilityValue: number | null = null;
  let availabilityBasis = 'Sin control de stock';
  if (i.stock && i.stock.status !== 'UNKNOWN') {
    const base = { IN_STOCK: 100, LOW_STOCK: 50, OUT_OF_STOCK: 0 }[i.stock.status];
    const stale = i.stock.ageHours > i.stock.maxAgeHours;
    availabilityValue = stale ? Math.round(base / 2) : base;
    availabilityBasis = `Stock ${i.stock.status}${stale ? ' (control vencido: mitad de puntos)' : ''}`;
  }
  const availability: ScoreComponent = {
    name: 'AVAILABILITY',
    weight: SCORE_WEIGHTS.AVAILABILITY,
    value: availabilityValue,
    basis: availabilityBasis,
  };

  const c = i.competitorCount;
  const competition: ScoreComponent = {
    name: 'COMPETITION',
    weight: SCORE_WEIGHTS.COMPETITION,
    value: c === null ? null : c <= 2 ? 90 : c <= 5 ? 70 : c <= 10 ? 40 : 15,
    basis: c === null ? 'Sin precios de competidores observados' : `${c} competidores en 30 días`,
  };

  const demandValue = { RISING: 90, STABLE: 60, FALLING: 25, INSUFFICIENT_DATA: null }[i.trend];
  const demand: ScoreComponent = {
    name: 'DEMAND',
    weight: SCORE_WEIGHTS.DEMAND,
    value: demandValue,
    basis:
      i.trend === 'INSUFFICIENT_DATA'
        ? 'Menos de 3 observaciones de demanda'
        : `Tendencia ${i.trend}`,
  };

  let logisticsValue: number | null = null;
  const d = i.logistics?.deliveryDaysMax ?? null;
  if (i.logistics && d !== null) {
    logisticsValue = clamp(
      (d <= 3 ? 100 : d <= 7 ? 75 : d <= 15 ? 40 : 10) - (i.logistics.trackingAvailable ? 0 : 20),
    );
  }
  const logistics: ScoreComponent = {
    name: 'LOGISTICS',
    weight: SCORE_WEIGHTS.LOGISTICS,
    value: logisticsValue,
    basis:
      logisticsValue === null
        ? 'Sin plazo de entrega del proveedor'
        : `Entrega máx. ${i.logistics?.deliveryDaysMax} días${i.logistics?.trackingAvailable ? ', con seguimiento' : ', sin seguimiento'}`,
  };

  const components = [profitability, supplier, availability, competition, demand, logistics];
  const total = clamp(components.reduce((acc, x) => acc + ((x.value ?? 0) * x.weight) / 100, 0));
  const knownWeight = components.filter((x) => x.value !== null).reduce((a, x) => a + x.weight, 0);
  return { total, confidence: Math.round(knownWeight) / 100, components };
};

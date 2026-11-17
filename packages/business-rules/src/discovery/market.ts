import type { DemandMetric, TrendDirection } from '@vc/shared';

const DAY_MS = 86_400_000;

export interface DemandPoint {
  readonly metric: DemandMetric;
  readonly value: number;
  readonly observedAt: Date;
}

export interface PricePoint {
  readonly priceCents: number;
  readonly competitorId: string | null;
  readonly observedAt: Date;
}

/** Métricas donde un número MENOR es mejor (p. ej. ranking de ventas). */
const LOWER_IS_BETTER: readonly DemandMetric[] = ['SALES_RANK'];

export const TREND_POLICY = {
  minPoints: 3,
  /** Cambio relativo cada 30 días para considerar suba/baja. */
  thresholdRatio: 0.1,
} as const;

/**
 * Tendencia a partir de observaciones REALES. Regresión lineal sobre la métrica
 * con más puntos; con menos de 3 puntos o sin variación temporal devuelve
 * INSUFFICIENT_DATA: nunca se extrapola demanda que no se observó.
 */
export const detectTrend = (
  points: readonly DemandPoint[],
): { direction: TrendDirection; metric: DemandMetric | null; points: number } => {
  const byMetric = new Map<DemandMetric, DemandPoint[]>();
  for (const p of points) byMetric.set(p.metric, [...(byMetric.get(p.metric) ?? []), p]);
  let best: [DemandMetric, DemandPoint[]] | null = null;
  for (const entry of byMetric) if (!best || entry[1].length > best[1].length) best = entry;
  if (!best || best[1].length < TREND_POLICY.minPoints) {
    return {
      direction: 'INSUFFICIENT_DATA',
      metric: best?.[0] ?? null,
      points: best?.[1].length ?? 0,
    };
  }
  const [metric, series] = best;
  const xs = series.map((p) => p.observedAt.getTime() / DAY_MS);
  const ys = series.map((p) => p.value);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (sxx === 0 || my === 0) return { direction: 'INSUFFICIENT_DATA', metric, points: n };
  const slopePerDay = xs.reduce((a, x, i) => a + (x - mx) * ((ys[i] ?? 0) - my), 0) / sxx;
  let change30 = (slopePerDay * 30) / Math.abs(my);
  if (LOWER_IS_BETTER.includes(metric)) change30 = -change30;
  const direction: TrendDirection =
    change30 > TREND_POLICY.thresholdRatio
      ? 'RISING'
      : change30 < -TREND_POLICY.thresholdRatio
        ? 'FALLING'
        : 'STABLE';
  return { direction, metric, points: n };
};

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? null) : Math.round(((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
};

export interface PriceSummary {
  readonly competitorCount: number;
  readonly observations: number;
  readonly medianPriceCents: number | null;
  /** Variación de la mediana (últimos 30 días vs. 30 previos), en bps. null si falta un período. */
  readonly priceChangeBps: number | null;
}

export const summarizePrices = (points: readonly PricePoint[], now: Date): PriceSummary => {
  const t = now.getTime();
  const recent = points.filter((p) => t - p.observedAt.getTime() <= 30 * DAY_MS);
  const prior = points.filter((p) => {
    const age = t - p.observedAt.getTime();
    return age > 30 * DAY_MS && age <= 60 * DAY_MS;
  });
  const recentMedian = median(recent.map((p) => p.priceCents));
  const priorMedian = median(prior.map((p) => p.priceCents));
  return {
    competitorCount: new Set(recent.map((p) => p.competitorId).filter((c) => c !== null)).size,
    observations: points.length,
    medianPriceCents: recentMedian,
    priceChangeBps:
      recentMedian !== null && priorMedian
        ? Math.round(((recentMedian - priorMedian) * 10_000) / priorMedian)
        : null,
  };
};

export const SATURATION_POLICY = {
  maxCompetitors: 10,
  crowdedCompetitors: 5,
  /** Caída de precio que indica guerra de precios. */
  priceDropBps: -1_000,
} as const;

/** Saturación: solo con evidencia observada (competidores y precios registrados). */
export const detectSaturation = (
  prices: PriceSummary,
  trend: TrendDirection,
): { saturated: boolean; reasons: string[] } => {
  const reasons: string[] = [];
  const crowded = prices.competitorCount >= SATURATION_POLICY.crowdedCompetitors;
  if (prices.competitorCount >= SATURATION_POLICY.maxCompetitors) {
    reasons.push(`${prices.competitorCount} competidores activos en 30 días`);
  }
  if (
    crowded &&
    prices.priceChangeBps !== null &&
    prices.priceChangeBps <= SATURATION_POLICY.priceDropBps
  ) {
    reasons.push(
      `Precio mediano cayó ${Math.abs(prices.priceChangeBps / 100)} % con mercado concurrido`,
    );
  }
  if (crowded && trend === 'FALLING') reasons.push('Demanda en baja con mercado concurrido');
  return { saturated: reasons.length > 0, reasons };
};

export const OPPORTUNITY_POLICY = { minScore: 65, minConfidence: 0.6 } as const;

/**
 * Oportunidad = señal para investigar más, NO una aprobación. La promoción a
 * candidato depende exclusivamente de Risk Guardian.
 */
export const detectOpportunity = (input: {
  score: number;
  confidence: number;
  saturated: boolean;
  trend: TrendDirection;
}): { opportunity: boolean; reasons: string[] } => {
  const reasons: string[] = [];
  if (input.score < OPPORTUNITY_POLICY.minScore)
    reasons.push(`Puntaje ${input.score} < ${OPPORTUNITY_POLICY.minScore}`);
  if (input.confidence < OPPORTUNITY_POLICY.minConfidence) {
    reasons.push(`Datos insuficientes (confianza ${Math.round(input.confidence * 100)} %)`);
  }
  if (input.saturated) reasons.push('Mercado saturado');
  if (input.trend === 'FALLING') reasons.push('Demanda en baja');
  return reasons.length === 0
    ? { opportunity: true, reasons: ['Puntaje alto, datos suficientes, sin saturación'] }
    : { opportunity: false, reasons };
};

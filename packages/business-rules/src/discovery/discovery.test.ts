import { describe, expect, it } from 'vitest';
import type { ViabilityResult } from '../profit/viability';
import { suggestCategory } from './classify';
import {
  detectOpportunity,
  detectSaturation,
  detectTrend,
  summarizePrices,
  type DemandPoint,
  type PricePoint,
} from './market';
import { computeProductScore, type ProductScoreInput } from './product-score';
import { assessRisk } from './risk-guardian';

const NOW = new Date('2026-11-16T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const series = (values: number[], metric: DemandPoint['metric'] = 'SEARCH_INTEREST') =>
  values.map((value, i) => ({ metric, value, observedAt: daysAgo((values.length - 1 - i) * 7) }));

describe('detectTrend', () => {
  it('no inventa tendencia con menos de 3 observaciones', () => {
    expect(detectTrend([]).direction).toBe('INSUFFICIENT_DATA');
    expect(detectTrend(series([10, 50])).direction).toBe('INSUFFICIENT_DATA');
  });

  it('detecta suba, baja y estabilidad', () => {
    expect(detectTrend(series([20, 30, 45, 60])).direction).toBe('RISING');
    expect(detectTrend(series([60, 45, 30, 20])).direction).toBe('FALLING');
    expect(detectTrend(series([50, 51, 49, 50])).direction).toBe('STABLE');
  });

  it('en ranking de ventas, bajar el número es subir la demanda', () => {
    expect(detectTrend(series([900, 600, 300, 100], 'SALES_RANK')).direction).toBe('RISING');
  });

  it('usa la métrica con más puntos', () => {
    const r = detectTrend([...series([10, 20, 40, 80]), ...series([5, 1], 'REVIEWS_COUNT')]);
    expect(r).toEqual({ direction: 'RISING', metric: 'SEARCH_INTEREST', points: 4 });
  });
});

describe('precios, saturación y oportunidad', () => {
  const prices = (n: number, cents: number, age: number): PricePoint[] =>
    Array.from({ length: n }, (_, i) => ({
      priceCents: cents,
      competitorId: `c${i}`,
      observedAt: daysAgo(age),
    }));

  it('cuenta competidores recientes y la variación de la mediana', () => {
    const s = summarizePrices([...prices(6, 9_000, 5), ...prices(6, 10_000, 40)], NOW);
    expect(s).toMatchObject({
      competitorCount: 6,
      medianPriceCents: 9_000,
      priceChangeBps: -1_000,
    });
  });

  it('sin observaciones no hay mediana ni variación', () => {
    expect(summarizePrices([], NOW)).toEqual({
      competitorCount: 0,
      observations: 0,
      medianPriceCents: null,
      priceChangeBps: null,
    });
  });

  it('saturado por cantidad de competidores o guerra de precios', () => {
    expect(detectSaturation(summarizePrices(prices(12, 1_000, 3), NOW), 'STABLE').saturated).toBe(
      true,
    );
    const war = summarizePrices([...prices(6, 9_000, 5), ...prices(6, 10_000, 40)], NOW);
    expect(detectSaturation(war, 'STABLE').saturated).toBe(true);
    expect(detectSaturation(summarizePrices(prices(2, 1_000, 3), NOW), 'FALLING').saturated).toBe(
      false,
    );
  });

  it('oportunidad solo con puntaje y datos suficientes y sin saturación', () => {
    expect(
      detectOpportunity({ score: 80, confidence: 0.9, saturated: false, trend: 'RISING' })
        .opportunity,
    ).toBe(true);
    expect(
      detectOpportunity({ score: 80, confidence: 0.3, saturated: false, trend: 'RISING' })
        .opportunity,
    ).toBe(false);
    expect(
      detectOpportunity({ score: 80, confidence: 0.9, saturated: true, trend: 'RISING' })
        .opportunity,
    ).toBe(false);
  });
});

describe('computeProductScore', () => {
  const full: ProductScoreInput = {
    marginBps: 4_000,
    minMarginBps: 2_000,
    supplierScore: 100,
    stock: { status: 'IN_STOCK', ageHours: 1, maxAgeHours: 24 },
    competitorCount: 1,
    trend: 'RISING',
    logistics: { deliveryDaysMax: 3, trackingAvailable: true },
  };

  it('está entre 0 y 100 y es alto con todo favorable', () => {
    const s = computeProductScore(full);
    expect(s.total).toBe(97);
    expect(s.confidence).toBe(1);
  });

  it('los datos faltantes aportan 0 y bajan la confianza (no se suponen)', () => {
    const s = computeProductScore({
      marginBps: null,
      minMarginBps: 2_000,
      supplierScore: null,
      stock: null,
      competitorCount: null,
      trend: 'INSUFFICIENT_DATA',
      logistics: null,
    });
    expect(s.total).toBe(0);
    expect(s.confidence).toBe(0);
    expect(s.components.every((c) => c.value === null)).toBe(true);
  });

  it('margen negativo puntúa 0 en rentabilidad', () => {
    const s = computeProductScore({ ...full, marginBps: -500 });
    expect(s.components.find((c) => c.name === 'PROFITABILITY')?.value).toBe(0);
  });
});

describe('Risk Guardian', () => {
  const okViability: ViabilityResult = { status: 'PROFITABLE', issues: [], breakdown: null };

  it('aprueba solo con vínculos y viabilidad sin problemas', () => {
    expect(
      assessRisk({ hasSupplierOffer: true, hasProduct: true, viability: okViability }).passed,
    ).toBe(true);
  });

  it('sin vínculos bloquea todo', () => {
    const r = assessRisk({ hasSupplierOffer: false, hasProduct: false, viability: null });
    expect(r.passed).toBe(false);
    expect(r.blockers).toEqual(
      expect.arrayContaining(['SUPPLIER_LINKED', 'PRODUCT_LINKED', 'SUPPLIER_VERIFIED']),
    );
  });

  it('traduce cada problema de viabilidad en un bloqueo', () => {
    const r = assessRisk({
      hasSupplierOffer: true,
      hasProduct: true,
      viability: {
        status: 'BLOCKED',
        issues: ['SUPPLIER_NOT_VERIFIED', 'PRICE_STALE', 'BELOW_MIN_MARGIN'],
        breakdown: null,
      },
    });
    expect(r.blockers.sort()).toEqual(['MIN_MARGIN', 'PRICE_CURRENT', 'SUPPLIER_VERIFIED']);
  });

  it('la puntuación no es una entrada: un 100 no puede saltear controles', () => {
    // Por tipo, RiskInput no tiene campo de puntaje; un objeto con "score" extra no cambia el resultado.
    const withScore = {
      hasSupplierOffer: true,
      hasProduct: true,
      viability: { status: 'BLOCKED', issues: ['STOCK_UNKNOWN'], breakdown: null },
      score: 100,
    } as const;
    expect(assessRisk(withScore).passed).toBe(false);
  });
});

describe('suggestCategory', () => {
  const cats = [
    { id: 'hogar', keywords: ['cocina', 'organizador'] },
    { id: 'mascotas', keywords: ['perro', 'gato', 'mascota'] },
  ];
  it('elige la categoría con más coincidencias, sin importar tildes ni mayúsculas', () => {
    expect(suggestCategory('Comedero automático para PERRO y gato', cats)?.id).toBe('mascotas');
    expect(suggestCategory('Organizador de cocína', cats)?.id).toBe('hogar');
    expect(suggestCategory('Auriculares', cats)).toBeNull();
  });
});

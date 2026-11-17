import { describe, expect, it } from 'vitest';
import type { CostComponent } from '@vc/shared';
import type { EvidenceFact } from '../supplier/verification';
import { calculateProfit } from './calculate-profit';
import { evaluateViability, type ViabilityInput } from './viability';

const NOW = new Date('2026-11-16T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/** Estructura de costos de ejemplo para tests (no son tarifas reales de ningún canal). */
const COMPONENTS: CostComponent[] = [
  { kind: 'SHIPPING', name: 'Envío', fixedCents: 5_000 },
  { kind: 'CHANNEL_COMMISSION', name: 'Comisión canal', rateBps: 1_300 },
  { kind: 'PAYMENT_PROCESSING', name: 'Cobro', rateBps: 400, fixedCents: 100 },
  { kind: 'TAX', name: 'Impuesto', rateBps: 300 },
  { kind: 'WITHHOLDING', name: 'Retención', rateBps: 200 },
  { kind: 'RETURN_RESERVE', name: 'Reserva devoluciones', rateBps: 300 },
];

describe('calculateProfit (función pura)', () => {
  it('desglosa cada concepto y calcula beneficio y margen', () => {
    const r = calculateProfit({
      salePriceCents: 100_000,
      supplierCostCents: 40_000,
      components: COMPONENTS,
      minMarginBps: 2_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      supplierCostCents: 40_000,
      shippingCents: 5_000,
      commissionsCents: 13_000,
      paymentProcessingCents: 4_100,
      taxesCents: 3_000,
      withholdingsCents: 2_000,
      returnReserveCents: 3_000,
      totalCostsCents: 70_100,
      netProfitCents: 29_900,
      marginBps: 2_990,
      status: 'PROFITABLE',
    });
  });

  it('margen negativo', () => {
    const r = calculateProfit({
      salePriceCents: 50_000,
      supplierCostCents: 45_000,
      components: COMPONENTS,
    });
    expect(r.ok && r.value.status).toBe('NEGATIVE_MARGIN');
    expect(r.ok && r.value.netProfitCents).toBeLessThan(0);
  });

  it('margen inferior al mínimo (20 % por defecto)', () => {
    const r = calculateProfit({
      salePriceCents: 100_000,
      supplierCostCents: 55_000,
      components: COMPONENTS,
    });
    expect(r.ok && r.value.marginBps).toBe(1_490);
    expect(r.ok && r.value.minMarginBps).toBe(2_000);
    expect(r.ok && r.value.status).toBe('BELOW_MIN_MARGIN');
  });

  it('umbral configurable', () => {
    const r = calculateProfit({
      salePriceCents: 100_000,
      supplierCostCents: 55_000,
      components: COMPONENTS,
      minMarginBps: 1_000,
    });
    expect(r.ok && r.value.status).toBe('PROFITABLE');
  });

  it('rechaza entradas inválidas', () => {
    expect(calculateProfit({ salePriceCents: 0, supplierCostCents: 0, components: [] }).ok).toBe(
      false,
    );
    expect(
      calculateProfit({ salePriceCents: 100, supplierCostCents: 1.5, components: [] }).ok,
    ).toBe(false);
  });
});

const VALID_EVIDENCE: EvidenceFact[] = (
  ['IDENTITY', 'COMMERCIAL_TERMS', 'DISPATCH_CAPABILITY'] as const
).map((category) => ({ category, reviewStatus: 'ACCEPTED', expiresAt: null }));

const viable = (overrides: Partial<ViabilityInput> = {}): ViabilityInput => ({
  supplier: { status: 'VERIFIED', directDispatch: true },
  evidence: VALID_EVIDENCE,
  offer: { wholesalePriceCents: 40_000, currency: 'ARS', priceUpdatedAt: hoursAgo(2) },
  inventory: { stockStatus: 'IN_STOCK', checkedAt: hoursAgo(1) },
  product: { salePriceCents: 100_000, currency: 'ARS' },
  components: COMPONENTS,
  policy: { minMarginBps: 2_000, maxPriceAgeHours: 72, maxStockAgeHours: 24 },
  now: NOW,
  ...overrides,
});

const evaluate = (overrides: Partial<ViabilityInput> = {}) => {
  const r = evaluateViability(viable(overrides));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe('evaluateViability', () => {
  it('producto rentable: proveedor verificado, stock y precio vigentes, margen ≥ 20 %', () => {
    const r = evaluate();
    expect(r.status).toBe('PROFITABLE');
    expect(r.issues).toEqual([]);
  });

  it('proveedor sin verificar ⇒ BLOCKED', () => {
    const r = evaluate({ supplier: { status: 'UNVERIFIED', directDispatch: true } });
    expect(r.status).toBe('BLOCKED');
    expect(r.issues).toContain('SUPPLIER_NOT_VERIFIED');
  });

  it('stock desconocido (sin registro o UNKNOWN) ⇒ BLOCKED', () => {
    expect(evaluate({ inventory: null }).issues).toContain('STOCK_UNKNOWN');
    const r = evaluate({ inventory: { stockStatus: 'UNKNOWN', checkedAt: hoursAgo(1) } });
    expect(r.status).toBe('BLOCKED');
    expect(r.issues).toContain('STOCK_UNKNOWN');
  });

  it('stock viejo o agotado ⇒ BLOCKED', () => {
    expect(
      evaluate({ inventory: { stockStatus: 'IN_STOCK', checkedAt: hoursAgo(25) } }).issues,
    ).toContain('STOCK_STALE');
    expect(
      evaluate({ inventory: { stockStatus: 'OUT_OF_STOCK', checkedAt: hoursAgo(1) } }).issues,
    ).toContain('OUT_OF_STOCK');
  });

  it('precio desactualizado ⇒ BLOCKED', () => {
    const r = evaluate({
      offer: { wholesalePriceCents: 40_000, currency: 'ARS', priceUpdatedAt: hoursAgo(73) },
    });
    expect(r.status).toBe('BLOCKED');
    expect(r.issues).toEqual(['PRICE_STALE']);
  });

  it('margen negativo ⇒ NEGATIVE_MARGIN', () => {
    const r = evaluate({
      offer: { wholesalePriceCents: 90_000, currency: 'ARS', priceUpdatedAt: hoursAgo(1) },
    });
    expect(r.status).toBe('NEGATIVE_MARGIN');
    expect(r.issues).toEqual(['NEGATIVE_MARGIN']);
  });

  it('margen inferior al mínimo ⇒ BELOW_MIN_MARGIN', () => {
    const r = evaluate({
      offer: { wholesalePriceCents: 55_000, currency: 'ARS', priceUpdatedAt: hoursAgo(1) },
    });
    expect(r.status).toBe('BELOW_MIN_MARGIN');
  });

  it('monedas distintas sin cotización ⇒ BLOCKED sin cálculo', () => {
    const r = evaluate({
      offer: { wholesalePriceCents: 400, currency: 'USD', priceUpdatedAt: hoursAgo(1) },
    });
    expect(r).toEqual({ status: 'BLOCKED', issues: ['CURRENCY_MISMATCH'], breakdown: null });
  });

  it('acumula todos los problemas', () => {
    const r = evaluate({
      supplier: { status: 'SUSPENDED', directDispatch: true },
      inventory: null,
      offer: { wholesalePriceCents: 90_000, currency: 'ARS', priceUpdatedAt: hoursAgo(100) },
    });
    expect(r.issues).toEqual([
      'SUPPLIER_NOT_VERIFIED',
      'STOCK_UNKNOWN',
      'PRICE_STALE',
      'NEGATIVE_MARGIN',
    ]);
  });
});

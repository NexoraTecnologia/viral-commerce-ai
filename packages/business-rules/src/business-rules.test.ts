import { describe, expect, it } from 'vitest';
import { assertCommercialActionAllowed, calculateSalePrice } from './index';

describe('calculateSalePrice', () => {
  it('cumple el margen objetivo', () => {
    const r = calculateSalePrice({
      supplierCostCents: 10_000,
      shippingCostCents: 2_000,
      channelFeeBps: 1_000, // 10 %
      targetMarginBps: 2_000, // 20 %
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 12000 / 0.7 = 17142.857 → 17143
    expect(r.value.salePriceCents).toBe(17_143);
    expect(r.value.effectiveMarginBps).toBeGreaterThanOrEqual(1_999);
    expect(r.value.netProfitCents).toBe(r.value.salePriceCents - r.value.channelFeeCents - 12_000);
  });

  it('rechaza decimales y negativos', () => {
    const r = calculateSalePrice({
      supplierCostCents: 10.5,
      shippingCostCents: 0,
      channelFeeBps: 0,
      targetMarginBps: 0,
    });
    expect(r.ok).toBe(false);
  });

  it('rechaza comisión + margen >= 100 %', () => {
    const r = calculateSalePrice({
      supplierCostCents: 100,
      shippingCostCents: 0,
      channelFeeBps: 5_000,
      targetMarginBps: 5_000,
    });
    expect(r.ok).toBe(false);
  });
});

describe('assertCommercialActionAllowed', () => {
  it('bloquea por defecto', () => {
    const r = assertCommercialActionAllowed('charge_customer', { commercialActionsEnabled: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('COMMERCIAL_ACTIONS_DISABLED');
  });

  it('permite si está habilitado explícitamente', () => {
    const r = assertCommercialActionAllowed('charge_customer', { commercialActionsEnabled: true });
    expect(r.ok).toBe(true);
  });
});

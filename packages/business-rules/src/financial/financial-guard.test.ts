import { describe, expect, it } from 'vitest';
import type { FinancialGuardRequest } from '@vc/shared';
import { evaluateFinancialGuard } from './financial-guard';

const NOW = new Date('2026-11-16T12:00:00Z');
const POLICY = { maxFundsDataAgeHours: 24, maxReturnRiskBps: 1_500 };
const at = (iso: string) => new Date(iso).toISOString();

/** Valores de entrada de prueba: escenarios sintéticos para tests, no datos de la empresa. */
const base: FinancialGuardRequest = {
  availableFundsCents: 0,
  fundsAsOf: at('2026-11-16T10:00:00Z'),
  fundsSource: 'MANUAL',
  totalCostsCents: 50_000,
  expectedSettlementCents: 80_000,
  channelSettlementDate: at('2026-11-30T00:00:00Z'),
  supplierPaymentDueDate: at('2026-11-17T00:00:00Z'),
  returnRiskBps: 500,
  financing: null,
};

describe('evaluateFinancialGuard', () => {
  it('operación sin financiación: proveedor cobra antes de liquidar y no hay fondos ⇒ BLOCKED', () => {
    const r = evaluateFinancialGuard(base, POLICY, NOW);
    expect(r.decision).toBe('BLOCKED');
    expect(r.issues).toEqual(['PREPAYMENT_WITHOUT_FUNDS']);
    expect(r.requiresUpfrontFunds).toBe(true);
    expect(r.fundingGapDays).toBe(13);
    expect(r.requiredFundsCents).toBe(52_500); // costos + 5 % reserva
  });

  it('aprueba con fondos propios suficientes', () => {
    const r = evaluateFinancialGuard({ ...base, availableFundsCents: 52_500 }, POLICY, NOW);
    expect(r.decision).toBe('APPROVED');
    expect(r.projectedProfitCents).toBe(80_000 - 50_000 - 2_500);
  });

  it('fondos justos por debajo de la reserva ⇒ BLOCKED', () => {
    const r = evaluateFinancialGuard({ ...base, availableFundsCents: 52_499 }, POLICY, NOW);
    expect(r.issues).toEqual(['PREPAYMENT_WITHOUT_FUNDS']);
  });

  it('aprueba sin fondos si el canal liquida antes del vencimiento del proveedor', () => {
    const r = evaluateFinancialGuard(
      { ...base, supplierPaymentDueDate: at('2026-12-05T00:00:00Z') },
      POLICY,
      NOW,
    );
    expect(r.decision).toBe('APPROVED');
    expect(r.requiresUpfrontFunds).toBe(false);
  });

  it('financiación con plazo corto no cubre la brecha', () => {
    const r = evaluateFinancialGuard(
      {
        ...base,
        financing: {
          available: true,
          limitCents: 100_000,
          costBps: 300,
          termDays: 7,
          source: 'MANUAL',
        },
      },
      POLICY,
      NOW,
    );
    expect(r.issues).toEqual(['FINANCING_TERM_INSUFFICIENT']);
  });

  it('financiación con límite insuficiente', () => {
    const r = evaluateFinancialGuard(
      {
        ...base,
        financing: {
          available: true,
          limitCents: 10_000,
          costBps: 300,
          termDays: 30,
          source: 'MANUAL',
        },
      },
      POLICY,
      NOW,
    );
    expect(r.issues).toEqual(['INSUFFICIENT_FUNDS']);
  });

  it('financiación válida aprueba e incluye su costo', () => {
    const r = evaluateFinancialGuard(
      {
        ...base,
        financing: {
          available: true,
          limitCents: 60_000,
          costBps: 300,
          termDays: 30,
          source: 'MANUAL',
        },
      },
      POLICY,
      NOW,
    );
    expect(r.decision).toBe('APPROVED');
    expect(r.financingUsedCents).toBe(52_500);
    expect(r.financingCostCents).toBe(1_575);
  });

  it('financiación que vuelve negativa la operación ⇒ BLOCKED', () => {
    const r = evaluateFinancialGuard(
      {
        ...base,
        expectedSettlementCents: 53_000,
        financing: {
          available: true,
          limitCents: 60_000,
          costBps: 3_000,
          termDays: 30,
          source: 'MANUAL',
        },
      },
      POLICY,
      NOW,
    );
    expect(r.issues).toContain('UNPROFITABLE_AFTER_FINANCING');
  });

  it('dato de fondos viejo o futuro ⇒ BLOCKED', () => {
    const stale = { ...base, availableFundsCents: 99_999, fundsAsOf: at('2026-11-14T00:00:00Z') };
    expect(evaluateFinancialGuard(stale, POLICY, NOW).issues).toEqual(['FUNDS_DATA_STALE']);
    const future = { ...base, availableFundsCents: 99_999, fundsAsOf: at('2026-11-17T00:00:00Z') };
    expect(evaluateFinancialGuard(future, POLICY, NOW).issues).toEqual(['FUNDS_DATA_IN_FUTURE']);
  });

  it('costos mayores a la liquidación y riesgo de devolución alto ⇒ BLOCKED', () => {
    const r = evaluateFinancialGuard(
      {
        ...base,
        availableFundsCents: 999_999,
        expectedSettlementCents: 40_000,
        returnRiskBps: 2_000,
      },
      POLICY,
      NOW,
    );
    expect(r.issues).toEqual(['COSTS_EXCEED_SETTLEMENT', 'HIGH_RETURN_RISK']);
  });
});

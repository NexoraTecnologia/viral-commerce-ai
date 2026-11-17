import type { FinancialGuardIssue, FinancialGuardRequest, FinancialGuardResult } from '@vc/shared';

const BPS = 10_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface FinancialGuardPolicy {
  readonly maxFundsDataAgeHours: number;
  readonly maxReturnRiskBps: number;
}

/**
 * FINANCIAL GUARD — función pura. Decide si una operación puede aprobarse.
 *
 * Reglas:
 *  1. El dato de fondos debe ser reciente y no estar en el futuro (no se aceptan
 *     saldos supuestos ni viejos).
 *  2. Si el proveedor cobra ANTES de que el canal liquide, la operación necesita
 *     fondos propios (o financiación cuyo plazo cubra la brecha) por
 *     costos + reserva de devoluciones. Si no existen ⇒ BLOQUEAR.
 *  3. Aunque no haya brecha, los costos no pueden superar la liquidación esperada.
 *  4. Riesgo de devolución por encima del máximo ⇒ BLOQUEAR.
 *  5. Si se usa financiación, su costo no puede volver negativa la operación.
 *
 * Nunca completa datos faltantes con valores por defecto: el contrato de
 * entrada exige todos los campos con su procedencia.
 */
export const evaluateFinancialGuard = (
  req: FinancialGuardRequest,
  policy: FinancialGuardPolicy,
  now: Date,
): FinancialGuardResult => {
  const issues: FinancialGuardIssue[] = [];

  const fundsAge = now.getTime() - new Date(req.fundsAsOf).getTime();
  if (fundsAge < 0) issues.push('FUNDS_DATA_IN_FUTURE');
  else if (fundsAge > policy.maxFundsDataAgeHours * HOUR_MS) issues.push('FUNDS_DATA_STALE');

  const settlement = new Date(req.channelSettlementDate).getTime();
  const supplierDue = new Date(req.supplierPaymentDueDate).getTime();
  const requiresUpfrontFunds = supplierDue < settlement;
  const fundingGapDays = requiresUpfrontFunds ? Math.ceil((settlement - supplierDue) / DAY_MS) : 0;

  const returnReserveCents = Math.ceil((req.totalCostsCents * req.returnRiskBps) / BPS);
  const requiredFundsCents = requiresUpfrontFunds ? req.totalCostsCents + returnReserveCents : 0;

  let financingUsedCents = 0;
  if (requiresUpfrontFunds) {
    const shortfall = Math.max(0, requiredFundsCents - req.availableFundsCents);
    if (shortfall > 0) {
      const financing = req.financing;
      if (financing === null) {
        issues.push('PREPAYMENT_WITHOUT_FUNDS');
      } else if (financing.termDays < fundingGapDays) {
        issues.push('FINANCING_TERM_INSUFFICIENT');
      } else if (financing.limitCents < shortfall) {
        issues.push('INSUFFICIENT_FUNDS');
      } else {
        financingUsedCents = shortfall;
      }
    }
  }

  const financingCostCents =
    financingUsedCents > 0 && req.financing
      ? Math.ceil((financingUsedCents * req.financing.costBps) / BPS)
      : 0;

  if (req.totalCostsCents > req.expectedSettlementCents) issues.push('COSTS_EXCEED_SETTLEMENT');
  if (req.returnRiskBps > policy.maxReturnRiskBps) issues.push('HIGH_RETURN_RISK');

  const projectedProfitCents =
    req.expectedSettlementCents - req.totalCostsCents - returnReserveCents - financingCostCents;
  if (financingCostCents > 0 && projectedProfitCents < 0) {
    issues.push('UNPROFITABLE_AFTER_FINANCING');
  }

  return {
    decision: issues.length === 0 ? 'APPROVED' : 'BLOCKED',
    issues,
    requiresUpfrontFunds,
    fundingGapDays,
    returnReserveCents,
    requiredFundsCents,
    financingUsedCents,
    financingCostCents,
    projectedProfitCents,
  };
};

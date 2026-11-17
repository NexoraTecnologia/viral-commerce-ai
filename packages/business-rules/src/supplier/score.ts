import type { ScoreBreakdown } from '@vc/shared';
import type { EvidenceFact } from './verification';

export interface SupplierScoreFacts {
  readonly directDispatch: boolean;
  readonly trackingAvailable: boolean;
  readonly acceptsReturns: boolean;
  readonly returnWindowDays: number | null;
  readonly requiresPrepayment: boolean;
  readonly paymentDueDays: number | null;
  readonly dispatchLeadTimeDaysMax: number | null;
  readonly deliveryTimeDaysMax: number | null;
}

/**
 * Puntuación determinística 0–100. Pesos (documentados en docs/SUPPLIER_PROFIT_ENGINES.md):
 *  - Evidencia   40: identidad 15, condiciones comerciales 15, despacho 10.
 *  - Operación   35: despacho directo 10, seguimiento 8, entrega 10, preparación 7.
 *  - Comercial   25: acepta devoluciones 8, ventana 4, sin prepago 8, plazo de pago 5.
 *  - Penalidad: −5 por evidencia rechazada (máx. −15).
 * Los datos desconocidos (null) puntúan 0: nunca se asume lo favorable.
 */
export const scoreSupplier = (
  supplier: SupplierScoreFacts,
  evidence: readonly EvidenceFact[],
  now: Date,
): ScoreBreakdown => {
  const accepted = (category: EvidenceFact['category']) =>
    evidence.some(
      (e) =>
        e.category === category &&
        e.reviewStatus === 'ACCEPTED' &&
        (e.expiresAt === null || e.expiresAt.getTime() > now.getTime()),
    );

  const evidenceScore =
    (accepted('IDENTITY') ? 15 : 0) +
    (accepted('COMMERCIAL_TERMS') ? 15 : 0) +
    (accepted('DISPATCH_CAPABILITY') ? 10 : 0);

  const delivery = supplier.deliveryTimeDaysMax;
  const deliveryScore =
    delivery === null ? 0 : delivery <= 3 ? 10 : delivery <= 7 ? 7 : delivery <= 15 ? 4 : 0;
  const lead = supplier.dispatchLeadTimeDaysMax;
  const leadScore = lead === null ? 0 : lead <= 1 ? 7 : lead <= 3 ? 4 : 0;
  const operations =
    (supplier.directDispatch ? 10 : 0) +
    (supplier.trackingAvailable ? 8 : 0) +
    deliveryScore +
    leadScore;

  const window = supplier.returnWindowDays;
  const windowScore =
    !supplier.acceptsReturns || window === null ? 0 : window >= 30 ? 4 : window >= 10 ? 2 : 0;
  const due = supplier.paymentDueDays;
  const termScore = supplier.requiresPrepayment || due === null ? 0 : due >= 15 ? 5 : 2;
  const commercial =
    (supplier.acceptsReturns ? 8 : 0) +
    windowScore +
    (supplier.requiresPrepayment ? 0 : 8) +
    termScore;

  const rejected = evidence.filter((e) => e.reviewStatus === 'REJECTED').length;
  const penalties = -Math.min(15, rejected * 5);

  const total = Math.max(0, Math.min(100, evidenceScore + operations + commercial + penalties));
  return { total, evidence: evidenceScore, operations, commercial, penalties };
};

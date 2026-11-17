import { describe, expect, it } from 'vitest';
import { scoreSupplier, type SupplierScoreFacts } from './score';
import {
  isSupplierOperable,
  missingRequiredEvidence,
  validateSupplierTransition,
  type EvidenceFact,
} from './verification';

const NOW = new Date('2026-11-16T12:00:00Z');
const accepted = (
  category: EvidenceFact['category'],
  expiresAt: Date | null = null,
): EvidenceFact => ({
  category,
  reviewStatus: 'ACCEPTED',
  expiresAt,
});
const FULL_EVIDENCE = [
  accepted('IDENTITY'),
  accepted('COMMERCIAL_TERMS'),
  accepted('DISPATCH_CAPABILITY'),
];

describe('verificación de proveedores', () => {
  it('proveedor sin verificar: no puede pasar a VERIFIED sin evidencia', () => {
    const r = validateSupplierTransition(
      { status: 'UNDER_REVIEW', directDispatch: true },
      'VERIFIED',
      [],
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.details).toEqual({
        missingEvidence: ['IDENTITY', 'COMMERCIAL_TERMS', 'DISPATCH_CAPABILITY'],
      });
    }
  });

  it('no se puede saltar de UNVERIFIED a VERIFIED aunque haya evidencia', () => {
    const r = validateSupplierTransition(
      { status: 'UNVERIFIED', directDispatch: true },
      'VERIFIED',
      FULL_EVIDENCE,
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CONFLICT');
  });

  it('evidencia pendiente, rechazada o vencida no cuenta', () => {
    const evidence: EvidenceFact[] = [
      { category: 'IDENTITY', reviewStatus: 'PENDING', expiresAt: null },
      { category: 'COMMERCIAL_TERMS', reviewStatus: 'REJECTED', expiresAt: null },
      accepted('DISPATCH_CAPABILITY', new Date('2026-11-01T00:00:00Z')),
    ];
    expect(missingRequiredEvidence(evidence, NOW)).toEqual([
      'IDENTITY',
      'COMMERCIAL_TERMS',
      'DISPATCH_CAPABILITY',
    ]);
  });

  it('exige despacho directo para verificar', () => {
    const r = validateSupplierTransition(
      { status: 'UNDER_REVIEW', directDispatch: false },
      'VERIFIED',
      FULL_EVIDENCE,
      NOW,
    );
    expect(r.ok).toBe(false);
  });

  it('proveedor aprobado: UNDER_REVIEW → VERIFIED con evidencia completa', () => {
    const r = validateSupplierTransition(
      { status: 'UNDER_REVIEW', directDispatch: true },
      'VERIFIED',
      FULL_EVIDENCE,
      NOW,
    );
    expect(r).toEqual({ ok: true, value: { from: 'UNDER_REVIEW', to: 'VERIFIED' } });
    expect(
      isSupplierOperable({ status: 'VERIFIED', directDispatch: true }, FULL_EVIDENCE, NOW),
    ).toBe(true);
  });

  it('un VERIFIED con evidencia vencida deja de ser operable', () => {
    const expired = [
      accepted('IDENTITY', new Date('2026-11-15T00:00:00Z')),
      accepted('COMMERCIAL_TERMS'),
      accepted('DISPATCH_CAPABILITY'),
    ];
    expect(isSupplierOperable({ status: 'VERIFIED', directDispatch: true }, expired, NOW)).toBe(
      false,
    );
  });
});

describe('scoreSupplier', () => {
  const best: SupplierScoreFacts = {
    directDispatch: true,
    trackingAvailable: true,
    acceptsReturns: true,
    returnWindowDays: 30,
    requiresPrepayment: false,
    paymentDueDays: 30,
    dispatchLeadTimeDaysMax: 1,
    deliveryTimeDaysMax: 3,
  };

  it('máximo 100 con todo favorable', () => {
    expect(scoreSupplier(best, FULL_EVIDENCE, NOW).total).toBe(100);
  });

  it('datos desconocidos no suman y el rechazo penaliza', () => {
    const unknown: SupplierScoreFacts = {
      directDispatch: false,
      trackingAvailable: false,
      acceptsReturns: false,
      returnWindowDays: null,
      requiresPrepayment: true,
      paymentDueDays: null,
      dispatchLeadTimeDaysMax: null,
      deliveryTimeDaysMax: null,
    };
    const rejected: EvidenceFact = {
      category: 'IDENTITY',
      reviewStatus: 'REJECTED',
      expiresAt: null,
    };
    expect(scoreSupplier(unknown, [rejected], NOW)).toEqual({
      total: 0,
      evidence: 0,
      operations: 0,
      commercial: 0,
      penalties: -5,
    });
  });
});

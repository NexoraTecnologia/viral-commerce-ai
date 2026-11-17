import {
  appError,
  err,
  ok,
  REQUIRED_EVIDENCE_CATEGORIES,
  SUPPLIER_TRANSITIONS,
  type EvidenceCategory,
  type EvidenceReviewStatus,
  type Result,
  type SupplierStatus,
} from '@vc/shared';

/** Vista mínima de una evidencia para las reglas (sin I/O). */
export interface EvidenceFact {
  readonly category: EvidenceCategory;
  readonly reviewStatus: EvidenceReviewStatus;
  readonly expiresAt: Date | null;
}

export interface SupplierVerificationFacts {
  readonly status: SupplierStatus;
  readonly directDispatch: boolean;
}

const isEvidenceValid = (e: EvidenceFact, now: Date): boolean =>
  e.reviewStatus === 'ACCEPTED' && (e.expiresAt === null || e.expiresAt.getTime() > now.getTime());

/** Categorías obligatorias que NO tienen evidencia aceptada y vigente. */
export const missingRequiredEvidence = (
  evidence: readonly EvidenceFact[],
  now: Date,
): EvidenceCategory[] =>
  REQUIRED_EVIDENCE_CATEGORIES.filter(
    (category) => !evidence.some((e) => e.category === category && isEvidenceValid(e, now)),
  );

/**
 * Valida una transición de estado. Regla central: no se puede pasar a VERIFIED sin
 * evidencia aceptada y vigente de identidad, condiciones comerciales y capacidad
 * de despacho, y sin despacho directo (modelo sin inventario propio).
 */
export const validateSupplierTransition = (
  supplier: SupplierVerificationFacts,
  to: SupplierStatus,
  evidence: readonly EvidenceFact[],
  now: Date,
): Result<{ from: SupplierStatus; to: SupplierStatus }> => {
  const from = supplier.status;
  if (!SUPPLIER_TRANSITIONS[from].includes(to)) {
    return err(appError('CONFLICT', `Transición inválida: ${from} → ${to}`, { from, to }));
  }
  if (to === 'VERIFIED') {
    const missing = missingRequiredEvidence(evidence, now);
    if (missing.length > 0) {
      return err(
        appError('VALIDATION_ERROR', 'Falta evidencia aceptada y vigente para verificar', {
          missingEvidence: missing,
        }),
      );
    }
    if (!supplier.directDispatch) {
      return err(
        appError('VALIDATION_ERROR', 'Solo se verifican proveedores con despacho directo'),
      );
    }
  }
  return ok({ from, to });
};

/** Un proveedor VERIFIED cuya evidencia obligatoria venció deja de ser operable. */
export const isSupplierOperable = (
  supplier: SupplierVerificationFacts,
  evidence: readonly EvidenceFact[],
  now: Date,
): boolean =>
  supplier.status === 'VERIFIED' &&
  supplier.directDispatch &&
  missingRequiredEvidence(evidence, now).length === 0;

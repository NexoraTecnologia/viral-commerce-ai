import type { RiskAssessment, RiskCheck, ViabilityIssue } from '@vc/shared';
import type { ViabilityResult } from '../profit/viability';

/**
 * RISK GUARDIAN — controles OBLIGATORIOS para que un producto avance (candidato
 * y, en el futuro, publicación). Reutiliza la evaluación de viabilidad del Profit
 * Engine: proveedor verificado con evidencia vigente, stock confirmado y reciente,
 * precio vigente, misma moneda y margen mínimo.
 *
 * Por diseño NO recibe la puntuación comercial: un puntaje alto no puede
 * compensar ni saltear ningún control.
 */
export interface RiskInput {
  readonly hasSupplierOffer: boolean;
  readonly hasProduct: boolean;
  /** Evaluación fresca de viabilidad; null si faltan vínculos para calcularla. */
  readonly viability: ViabilityResult | null;
  readonly saturated?: boolean;
  readonly confidence?: number;
}

const ISSUE_TO_CHECK: Record<ViabilityIssue, RiskCheck> = {
  SUPPLIER_NOT_VERIFIED: 'SUPPLIER_VERIFIED',
  SUPPLIER_EVIDENCE_EXPIRED: 'SUPPLIER_VERIFIED',
  SUPPLIER_NO_DIRECT_DISPATCH: 'SUPPLIER_VERIFIED',
  STOCK_UNKNOWN: 'STOCK_CONFIRMED',
  STOCK_STALE: 'STOCK_CONFIRMED',
  OUT_OF_STOCK: 'STOCK_CONFIRMED',
  PRICE_STALE: 'PRICE_CURRENT',
  CURRENCY_MISMATCH: 'CURRENCY_MATCH',
  NEGATIVE_MARGIN: 'MIN_MARGIN',
  BELOW_MIN_MARGIN: 'MIN_MARGIN',
};

export const assessRisk = (input: RiskInput): RiskAssessment => {
  const blockers = new Set<RiskCheck>();
  if (!input.hasSupplierOffer) blockers.add('SUPPLIER_LINKED');
  if (!input.hasProduct) blockers.add('PRODUCT_LINKED');
  if (input.viability === null) {
    // Sin vínculos no hay forma de verificar el resto: todo queda bloqueado.
    blockers.add('SUPPLIER_VERIFIED');
    blockers.add('STOCK_CONFIRMED');
    blockers.add('PRICE_CURRENT');
    blockers.add('MIN_MARGIN');
  } else {
    for (const issue of input.viability.issues) blockers.add(ISSUE_TO_CHECK[issue]);
  }

  const warnings: string[] = [];
  if (input.saturated) warnings.push('Mercado saturado según precios y competidores observados');
  if (input.confidence !== undefined && input.confidence < 0.6) {
    warnings.push('Puntuación con pocos datos observados');
  }
  return { passed: blockers.size === 0, blockers: [...blockers], warnings };
};

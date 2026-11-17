import type {
  Currency,
  EvidenceCategory,
  FinancialGuardIssue,
  ProfitStatus,
  StockStatus,
  SupplierStatus,
  ViabilityIssue,
} from '@vc/shared';

export const formatCents = (cents: number, currency: Currency = 'ARS'): string =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency }).format(cents / 100);

export const formatBps = (bps: number): string =>
  `${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(bps / 100)} %`;

export const formatDateTime = (iso: string): string =>
  new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(iso),
  );

export const hoursSince = (iso: string, now = Date.now()): number =>
  Math.floor((now - new Date(iso).getTime()) / 3_600_000);

/**
 * Convierte un monto escrito por el usuario a centavos.
 * Acepta "1234", "1234,56", "1234.56", "1.234,56". Devuelve null si es inválido.
 */
export const parseMoneyInput = (raw: string): number | null => {
  let s = raw.trim().replace(/\s|\$/g, '');
  if (s === '') return null;
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [int = '0', dec = ''] = s.split('.');
  return Number(int) * 100 + Number(dec.padEnd(2, '0'));
};

/** Convierte un porcentaje escrito ("13", "4,99") a basis points. */
export const parsePercentInput = (raw: string): number | null => {
  const s = raw.trim().replace('%', '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const bps = Math.round(Number(s) * 100);
  return bps <= 10_000 ? bps : null;
};

export const SUPPLIER_STATUS_LABEL: Record<SupplierStatus, string> = {
  UNVERIFIED: 'Sin verificar',
  UNDER_REVIEW: 'En revisión',
  VERIFIED: 'Verificado',
  SUSPENDED: 'Suspendido',
  REJECTED: 'Rechazado',
};

export const EVIDENCE_LABEL: Record<EvidenceCategory, string> = {
  IDENTITY: 'Identidad',
  COMMERCIAL_TERMS: 'Condiciones comerciales',
  DISPATCH_CAPABILITY: 'Capacidad de despacho',
  OTHER: 'Otra',
};

export const STOCK_LABEL: Record<StockStatus, string> = {
  IN_STOCK: 'Con stock',
  LOW_STOCK: 'Stock bajo',
  OUT_OF_STOCK: 'Sin stock',
  UNKNOWN: 'Desconocido',
};

export const PROFIT_STATUS_LABEL: Record<ProfitStatus, string> = {
  PROFITABLE: 'Rentable',
  BELOW_MIN_MARGIN: 'Margen bajo',
  NEGATIVE_MARGIN: 'Pérdida',
  BLOCKED: 'Bloqueado',
};

export const ISSUE_LABEL: Record<ViabilityIssue | FinancialGuardIssue, string> = {
  SUPPLIER_NOT_VERIFIED: 'Proveedor sin verificar',
  SUPPLIER_EVIDENCE_EXPIRED: 'Evidencia del proveedor vencida',
  SUPPLIER_NO_DIRECT_DISPATCH: 'Proveedor sin despacho directo',
  STOCK_UNKNOWN: 'Stock desconocido',
  STOCK_STALE: 'Control de stock desactualizado',
  OUT_OF_STOCK: 'Sin stock',
  PRICE_STALE: 'Precio desactualizado',
  CURRENCY_MISMATCH: 'Monedas distintas',
  NEGATIVE_MARGIN: 'Margen negativo',
  BELOW_MIN_MARGIN: 'Margen inferior al mínimo',
  FUNDS_DATA_STALE: 'Dato de fondos desactualizado',
  FUNDS_DATA_IN_FUTURE: 'Fecha de fondos en el futuro',
  PREPAYMENT_WITHOUT_FUNDS: 'El proveedor cobra antes de que haya fondos',
  FINANCING_TERM_INSUFFICIENT: 'El plazo de financiación no cubre la brecha',
  INSUFFICIENT_FUNDS: 'Fondos y financiación insuficientes',
  COSTS_EXCEED_SETTLEMENT: 'Los costos superan la liquidación',
  HIGH_RETURN_RISK: 'Riesgo de devolución alto',
  UNPROFITABLE_AFTER_FINANCING: 'Pierde dinero tras financiar',
};

export type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';

export const supplierTone = (s: SupplierStatus): Tone =>
  s === 'VERIFIED'
    ? 'good'
    : s === 'UNDER_REVIEW'
      ? 'warn'
      : s === 'UNVERIFIED'
        ? 'neutral'
        : 'bad';

export const stockTone = (s: StockStatus): Tone =>
  s === 'IN_STOCK' ? 'good' : s === 'LOW_STOCK' ? 'warn' : s === 'OUT_OF_STOCK' ? 'bad' : 'neutral';

export const profitTone = (s: ProfitStatus): Tone =>
  s === 'PROFITABLE' ? 'good' : s === 'BELOW_MIN_MARGIN' ? 'warn' : 'bad';

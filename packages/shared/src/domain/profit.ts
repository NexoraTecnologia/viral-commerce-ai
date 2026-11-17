import { z } from 'zod';
import { CurrencySchema } from '../money';
import { BpsSchema, CentsSchema, DataSourceSchema, IsoDateTimeSchema } from './common';
import { CostComponentKindSchema, CostComponentSchema } from './catalog';

export const ProfitStatusSchema = z.enum([
  'PROFITABLE',
  'BELOW_MIN_MARGIN',
  'NEGATIVE_MARGIN',
  'BLOCKED',
]);
export type ProfitStatus = z.infer<typeof ProfitStatusSchema>;

/** Motivos por los que un producto no puede operarse. */
export const ViabilityIssueSchema = z.enum([
  'SUPPLIER_NOT_VERIFIED',
  'SUPPLIER_EVIDENCE_EXPIRED',
  'SUPPLIER_NO_DIRECT_DISPATCH',
  'STOCK_UNKNOWN',
  'STOCK_STALE',
  'OUT_OF_STOCK',
  'PRICE_STALE',
  'CURRENCY_MISMATCH',
  'NEGATIVE_MARGIN',
  'BELOW_MIN_MARGIN',
]);
export type ViabilityIssue = z.infer<typeof ViabilityIssueSchema>;

export const ProfitSimulationRequestSchema = z.object({
  salePriceCents: CentsSchema.refine((v) => v > 0, 'El precio de venta debe ser mayor a 0'),
  supplierCostCents: CentsSchema,
  components: z.array(CostComponentSchema).max(50),
  minMarginBps: BpsSchema.optional(),
});
export type ProfitSimulationRequest = z.infer<typeof ProfitSimulationRequestSchema>;

export const ProfitLineSchema = z.object({
  kind: z.union([CostComponentKindSchema, z.literal('SUPPLIER_COST')]),
  name: z.string(),
  amountCents: z.number().int(),
});
export type ProfitLine = z.infer<typeof ProfitLineSchema>;

export const ProfitBreakdownSchema = z.object({
  salePriceCents: z.number().int(),
  supplierCostCents: z.number().int(),
  shippingCents: z.number().int(),
  commissionsCents: z.number().int(),
  paymentProcessingCents: z.number().int(),
  taxesCents: z.number().int(),
  withholdingsCents: z.number().int(),
  returnReserveCents: z.number().int(),
  otherCostsCents: z.number().int(),
  totalCostsCents: z.number().int(),
  netProfitCents: z.number().int(),
  marginBps: z.number().int(),
  minMarginBps: z.number().int(),
  status: z.enum(['PROFITABLE', 'BELOW_MIN_MARGIN', 'NEGATIVE_MARGIN']),
  lines: z.array(ProfitLineSchema),
});
export type ProfitBreakdown = z.infer<typeof ProfitBreakdownSchema>;

export const CreateProfitCalculationRequestSchema = z.object({
  supplierProductId: z.uuid(),
});

export const ProfitCalculationDtoSchema = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  productTitle: z.string(),
  supplierProductId: z.uuid(),
  currency: CurrencySchema,
  status: ProfitStatusSchema,
  issues: z.array(ViabilityIssueSchema),
  breakdown: ProfitBreakdownSchema.nullable(),
  calculatedAt: IsoDateTimeSchema,
});
export type ProfitCalculationDto = z.infer<typeof ProfitCalculationDtoSchema>;

/* ---------- Financial Guard ---------- */

export const FinancialGuardRequestSchema = z.object({
  /** Fondos disponibles reales. Se exige origen y fecha del dato. */
  availableFundsCents: CentsSchema,
  fundsAsOf: IsoDateTimeSchema,
  fundsSource: DataSourceSchema,
  /** Costos totales de la operación a desembolsar (proveedor, envío, etc.). */
  totalCostsCents: CentsSchema,
  /** Monto neto que liquidará el canal de venta. */
  expectedSettlementCents: CentsSchema,
  /** Fecha en que el canal liquida los fondos de la venta. */
  channelSettlementDate: IsoDateTimeSchema,
  /** Fecha de vencimiento del pago al proveedor. */
  supplierPaymentDueDate: IsoDateTimeSchema,
  /** Probabilidad estimada de devolución (bps). */
  returnRiskBps: BpsSchema,
  financing: z
    .object({
      available: z.literal(true),
      limitCents: CentsSchema,
      /** Costo total de la financiación sobre el monto usado (bps). */
      costBps: BpsSchema,
      termDays: z.number().int().min(1).max(365),
      source: DataSourceSchema,
    })
    .nullable(),
});
export type FinancialGuardRequest = z.infer<typeof FinancialGuardRequestSchema>;

export const FinancialGuardIssueSchema = z.enum([
  'FUNDS_DATA_STALE',
  'FUNDS_DATA_IN_FUTURE',
  'PREPAYMENT_WITHOUT_FUNDS',
  'FINANCING_TERM_INSUFFICIENT',
  'INSUFFICIENT_FUNDS',
  'COSTS_EXCEED_SETTLEMENT',
  'HIGH_RETURN_RISK',
  'UNPROFITABLE_AFTER_FINANCING',
]);
export type FinancialGuardIssue = z.infer<typeof FinancialGuardIssueSchema>;

export const FinancialGuardResultSchema = z.object({
  decision: z.enum(['APPROVED', 'BLOCKED']),
  issues: z.array(FinancialGuardIssueSchema),
  requiresUpfrontFunds: z.boolean(),
  fundingGapDays: z.number().int(),
  returnReserveCents: z.number().int(),
  requiredFundsCents: z.number().int(),
  financingUsedCents: z.number().int(),
  financingCostCents: z.number().int(),
  projectedProfitCents: z.number().int(),
});
export type FinancialGuardResult = z.infer<typeof FinancialGuardResultSchema>;

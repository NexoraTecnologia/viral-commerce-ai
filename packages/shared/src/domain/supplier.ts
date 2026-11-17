import { z } from 'zod';
import { IsoDateTimeSchema } from './common';

export const SupplierStatusSchema = z.enum([
  'UNVERIFIED',
  'UNDER_REVIEW',
  'VERIFIED',
  'SUSPENDED',
  'REJECTED',
]);
export type SupplierStatus = z.infer<typeof SupplierStatusSchema>;

/** Máquina de estados del proveedor. Cualquier transición no listada es inválida. */
export const SUPPLIER_TRANSITIONS: Readonly<Record<SupplierStatus, readonly SupplierStatus[]>> = {
  UNVERIFIED: ['UNDER_REVIEW', 'REJECTED'],
  UNDER_REVIEW: ['VERIFIED', 'REJECTED', 'UNVERIFIED'],
  VERIFIED: ['SUSPENDED', 'UNDER_REVIEW'],
  SUSPENDED: ['UNDER_REVIEW', 'REJECTED'],
  REJECTED: ['UNDER_REVIEW'],
};

/** Categorías de evidencia. Las tres primeras son obligatorias para VERIFIED. */
export const EvidenceCategorySchema = z.enum([
  'IDENTITY',
  'COMMERCIAL_TERMS',
  'DISPATCH_CAPABILITY',
  'OTHER',
]);
export type EvidenceCategory = z.infer<typeof EvidenceCategorySchema>;

export const REQUIRED_EVIDENCE_CATEGORIES = [
  'IDENTITY',
  'COMMERCIAL_TERMS',
  'DISPATCH_CAPABILITY',
] as const satisfies readonly EvidenceCategory[];

export const EvidenceReviewStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'REJECTED']);
export type EvidenceReviewStatus = z.infer<typeof EvidenceReviewStatusSchema>;

/** Medios de pago que acepta el proveedor (categorías, no integraciones). */
export const PaymentMethodSchema = z.enum([
  'BANK_TRANSFER',
  'MERCADO_PAGO',
  'CREDIT_CARD',
  'DEBIT_CARD',
  'CASH',
  'CHECK',
  'OTHER',
]);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const SupplierContactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(80).optional(),
  email: z.email().optional(),
  phone: z.string().trim().max(40).optional(),
});
export type SupplierContact = z.infer<typeof SupplierContactSchema>;

const days = z.number().int().min(0).max(365);

/** CUIT/CUIL argentino: 11 dígitos, guiones opcionales. Solo formato, no validez fiscal. */
const CuitSchema = z
  .string()
  .trim()
  .regex(/^\d{2}-?\d{8}-?\d$/, 'Formato de CUIT inválido');

const supplierFields = {
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().max(200).optional(),
  taxId: CuitSchema.optional(),
  /** ISO 3166-1 alpha-2. */
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Z]{2}$/, 'Código de país ISO de 2 letras'),
  province: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
  address: z.string().trim().max(300).optional(),
  website: z.url().optional(),
  contacts: z.array(SupplierContactSchema).max(20).default([]),
  paymentMethods: z.array(PaymentMethodSchema).max(10).default([]),
  /** El proveedor despacha directamente al comprador final. */
  directDispatch: z.boolean(),
  dispatchLeadTimeDaysMin: days.optional(),
  dispatchLeadTimeDaysMax: days.optional(),
  deliveryTimeDaysMin: days.optional(),
  deliveryTimeDaysMax: days.optional(),
  acceptsReturns: z.boolean(),
  returnWindowDays: days.optional(),
  returnPolicyNotes: z.string().trim().max(2000).optional(),
  trackingAvailable: z.boolean(),
  /** El proveedor exige el pago antes de despachar. */
  requiresPrepayment: z.boolean(),
  /** Días desde el pedido hasta el vencimiento del pago al proveedor (0 = al pedir). */
  paymentDueDays: days.optional(),
};

const rangesAreValid = (s: {
  dispatchLeadTimeDaysMin?: number | undefined;
  dispatchLeadTimeDaysMax?: number | undefined;
  deliveryTimeDaysMin?: number | undefined;
  deliveryTimeDaysMax?: number | undefined;
}) =>
  (s.dispatchLeadTimeDaysMin === undefined ||
    s.dispatchLeadTimeDaysMax === undefined ||
    s.dispatchLeadTimeDaysMin <= s.dispatchLeadTimeDaysMax) &&
  (s.deliveryTimeDaysMin === undefined ||
    s.deliveryTimeDaysMax === undefined ||
    s.deliveryTimeDaysMin <= s.deliveryTimeDaysMax);

const RANGE_MESSAGE = { message: 'El mínimo no puede superar al máximo' };

export const CreateSupplierRequestSchema = z
  .object(supplierFields)
  .refine(rangesAreValid, RANGE_MESSAGE);
export type CreateSupplierRequest = z.infer<typeof CreateSupplierRequestSchema>;

export const UpdateSupplierRequestSchema = z
  .object(supplierFields)
  .partial()
  .refine(rangesAreValid, RANGE_MESSAGE);
export type UpdateSupplierRequest = z.infer<typeof UpdateSupplierRequestSchema>;

export const SupplierDtoSchema = z.object({
  id: z.uuid(),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  taxId: z.string().nullable(),
  countryCode: z.string(),
  province: z.string().nullable(),
  city: z.string().nullable(),
  address: z.string().nullable(),
  website: z.string().nullable(),
  contacts: z.array(SupplierContactSchema),
  paymentMethods: z.array(PaymentMethodSchema),
  directDispatch: z.boolean(),
  dispatchLeadTimeDaysMin: z.number().nullable(),
  dispatchLeadTimeDaysMax: z.number().nullable(),
  deliveryTimeDaysMin: z.number().nullable(),
  deliveryTimeDaysMax: z.number().nullable(),
  acceptsReturns: z.boolean(),
  returnWindowDays: z.number().nullable(),
  returnPolicyNotes: z.string().nullable(),
  trackingAvailable: z.boolean(),
  requiresPrepayment: z.boolean(),
  paymentDueDays: z.number().nullable(),
  status: SupplierStatusSchema,
  score: z.number().int().min(0).max(100),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type SupplierDto = z.infer<typeof SupplierDtoSchema>;

export const RecordEvidenceRequestSchema = z.object({
  category: EvidenceCategorySchema,
  description: z.string().trim().min(5).max(1000),
  /** Referencia verificable: URL, número de constancia, ID de documento archivado. */
  reference: z.string().trim().min(3).max(500),
  expiresAt: IsoDateTimeSchema.optional(),
});
export type RecordEvidenceRequest = z.infer<typeof RecordEvidenceRequestSchema>;

export const ReviewEvidenceRequestSchema = z.object({
  decision: z.enum(['ACCEPTED', 'REJECTED']),
  notes: z.string().trim().max(1000).optional(),
});
export type ReviewEvidenceRequest = z.infer<typeof ReviewEvidenceRequestSchema>;

export const EvidenceDtoSchema = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  category: EvidenceCategorySchema,
  description: z.string(),
  reference: z.string(),
  reviewStatus: EvidenceReviewStatusSchema,
  reviewNotes: z.string().nullable(),
  reviewedAt: IsoDateTimeSchema.nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type EvidenceDto = z.infer<typeof EvidenceDtoSchema>;

export const ChangeSupplierStatusRequestSchema = z.object({
  to: SupplierStatusSchema,
  reason: z.string().trim().min(3).max(1000),
});
export type ChangeSupplierStatusRequest = z.infer<typeof ChangeSupplierStatusRequestSchema>;

export const StatusHistoryDtoSchema = z.object({
  id: z.uuid(),
  fromStatus: SupplierStatusSchema,
  toStatus: SupplierStatusSchema,
  reason: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type StatusHistoryDto = z.infer<typeof StatusHistoryDtoSchema>;

export const ScoreBreakdownSchema = z.object({
  total: z.number().int().min(0).max(100),
  evidence: z.number().int(),
  operations: z.number().int(),
  commercial: z.number().int(),
  penalties: z.number().int(),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

export const SupplierDetailDtoSchema = z.object({
  supplier: SupplierDtoSchema,
  evidence: z.array(EvidenceDtoSchema),
  history: z.array(StatusHistoryDtoSchema),
  score: ScoreBreakdownSchema,
  missingEvidence: z.array(EvidenceCategorySchema),
});
export type SupplierDetailDto = z.infer<typeof SupplierDetailDtoSchema>;

import { and, desc, eq } from 'drizzle-orm';
import {
  missingRequiredEvidence,
  scoreSupplier,
  validateSupplierTransition,
  type EvidenceFact,
} from '@vc/business-rules';
import {
  auditEvents,
  supplierEvidence,
  suppliers,
  supplierStatusHistory,
  type Database,
  type SupplierEvidenceRow,
  type SupplierRow,
} from '@vc/database';
import {
  appError,
  err,
  newId,
  ok,
  type ChangeSupplierStatusRequest,
  type CreateSupplierRequest,
  type EvidenceDto,
  type RecordEvidenceRequest,
  type Result,
  type ReviewEvidenceRequest,
  type SupplierDetailDto,
  type SupplierDto,
  type UpdateSupplierRequest,
} from '@vc/shared';
import { iso, isoOrNull, notFound } from '../../http';

/* ---------- Mapeo fila → DTO ---------- */

export const toSupplierDto = (s: SupplierRow): SupplierDto => ({
  id: s.id,
  legalName: s.legalName,
  tradeName: s.tradeName,
  taxId: s.taxId,
  countryCode: s.countryCode,
  province: s.province,
  city: s.city,
  address: s.address,
  website: s.website,
  contacts: s.contacts,
  paymentMethods: s.paymentMethods,
  directDispatch: s.directDispatch,
  dispatchLeadTimeDaysMin: s.dispatchLeadTimeDaysMin,
  dispatchLeadTimeDaysMax: s.dispatchLeadTimeDaysMax,
  deliveryTimeDaysMin: s.deliveryTimeDaysMin,
  deliveryTimeDaysMax: s.deliveryTimeDaysMax,
  acceptsReturns: s.acceptsReturns,
  returnWindowDays: s.returnWindowDays,
  returnPolicyNotes: s.returnPolicyNotes,
  trackingAvailable: s.trackingAvailable,
  requiresPrepayment: s.requiresPrepayment,
  paymentDueDays: s.paymentDueDays,
  status: s.status,
  score: s.score,
  createdAt: iso(s.createdAt),
  updatedAt: iso(s.updatedAt),
});

const toEvidenceDto = (e: SupplierEvidenceRow): EvidenceDto => ({
  id: e.id,
  supplierId: e.supplierId,
  category: e.category,
  description: e.description,
  reference: e.reference,
  reviewStatus: e.reviewStatus,
  reviewNotes: e.reviewNotes,
  reviewedAt: isoOrNull(e.reviewedAt),
  expiresAt: isoOrNull(e.expiresAt),
  createdAt: iso(e.createdAt),
});

export const toEvidenceFacts = (rows: readonly SupplierEvidenceRow[]): EvidenceFact[] =>
  rows.map((e) => ({ category: e.category, reviewStatus: e.reviewStatus, expiresAt: e.expiresAt }));

/** Convierte `undefined` opcionales del request a `null` para la DB. */
const nullable = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/* ---------- Consultas ---------- */

export const findSupplier = (db: Database, tenantId: string, id: string) =>
  db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, id)))
    .get();

export const listEvidence = (db: Database, tenantId: string, supplierId: string) =>
  db
    .select()
    .from(supplierEvidence)
    .where(
      and(eq(supplierEvidence.tenantId, tenantId), eq(supplierEvidence.supplierId, supplierId)),
    )
    .orderBy(desc(supplierEvidence.createdAt))
    .all();

export const listSuppliers = async (db: Database, tenantId: string): Promise<SupplierDto[]> => {
  const rows = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.tenantId, tenantId))
    .orderBy(desc(suppliers.score), suppliers.legalName)
    .limit(500);
  return rows.map(toSupplierDto);
};

const computeScore = (s: SupplierRow, evidence: readonly SupplierEvidenceRow[], now: Date) =>
  scoreSupplier(s, toEvidenceFacts(evidence), now);

const refreshScore = async (db: Database, s: SupplierRow, now: Date): Promise<SupplierRow> => {
  const evidence = await listEvidence(db, s.tenantId, s.id);
  const score = computeScore(s, evidence, now).total;
  if (score === s.score) return s;
  return db
    .update(suppliers)
    .set({ score, updatedAt: now })
    .where(eq(suppliers.id, s.id))
    .returning()
    .get();
};

export const getSupplierDetail = async (
  db: Database,
  tenantId: string,
  id: string,
  now: Date,
): Promise<Result<SupplierDetailDto>> => {
  const supplier = await findSupplier(db, tenantId, id);
  if (!supplier) return notFound('Proveedor');
  const [evidence, history] = await Promise.all([
    listEvidence(db, tenantId, id),
    db
      .select()
      .from(supplierStatusHistory)
      .where(
        and(eq(supplierStatusHistory.tenantId, tenantId), eq(supplierStatusHistory.supplierId, id)),
      )
      .orderBy(desc(supplierStatusHistory.createdAt))
      .all(),
  ]);
  return ok({
    supplier: toSupplierDto(supplier),
    evidence: evidence.map(toEvidenceDto),
    history: history.map((h) => ({
      id: h.id,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      reason: h.reason,
      createdAt: iso(h.createdAt),
    })),
    score: computeScore(supplier, evidence, now),
    missingEvidence: missingRequiredEvidence(toEvidenceFacts(evidence), now),
  });
};

/* ---------- Comandos ---------- */

export const createSupplier = async (
  db: Database,
  tenantId: string,
  input: CreateSupplierRequest,
  now: Date,
): Promise<SupplierDto> => {
  const values = {
    id: newId(),
    tenantId,
    legalName: input.legalName,
    tradeName: nullable(input.tradeName),
    taxId: nullable(input.taxId),
    countryCode: input.countryCode,
    province: nullable(input.province),
    city: nullable(input.city),
    address: nullable(input.address),
    website: nullable(input.website),
    contacts: input.contacts,
    paymentMethods: input.paymentMethods,
    directDispatch: input.directDispatch,
    dispatchLeadTimeDaysMin: nullable(input.dispatchLeadTimeDaysMin),
    dispatchLeadTimeDaysMax: nullable(input.dispatchLeadTimeDaysMax),
    deliveryTimeDaysMin: nullable(input.deliveryTimeDaysMin),
    deliveryTimeDaysMax: nullable(input.deliveryTimeDaysMax),
    acceptsReturns: input.acceptsReturns,
    returnWindowDays: nullable(input.returnWindowDays),
    returnPolicyNotes: nullable(input.returnPolicyNotes),
    trackingAvailable: input.trackingAvailable,
    requiresPrepayment: input.requiresPrepayment,
    paymentDueDays: nullable(input.paymentDueDays),
    status: 'UNVERIFIED' as const,
    createdAt: now,
    updatedAt: now,
  };
  const score = scoreSupplier(values, [], now).total;
  const row = await db
    .insert(suppliers)
    .values({ ...values, score })
    .returning()
    .get();
  return toSupplierDto(row);
};

/** Campos cuyo cambio invalida una verificación previa. */
const MATERIAL_FIELDS = [
  'legalName',
  'taxId',
  'countryCode',
  'directDispatch',
  'requiresPrepayment',
  'paymentDueDays',
  'acceptsReturns',
  'returnWindowDays',
] as const satisfies readonly (keyof UpdateSupplierRequest)[];

export const updateSupplier = async (
  db: Database,
  tenantId: string,
  id: string,
  input: UpdateSupplierRequest,
  now: Date,
): Promise<Result<SupplierDto>> => {
  const current = await findSupplier(db, tenantId, id);
  if (!current) return notFound('Proveedor');

  const patch = Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  ) as Partial<SupplierRow>;
  const materialChange = MATERIAL_FIELDS.some((f) => f in patch && patch[f] !== current[f]);
  const revokeVerification = current.status === 'VERIFIED' && materialChange;

  const merged: SupplierRow = { ...current, ...patch };
  const evidence = await listEvidence(db, tenantId, id);
  const score = computeScore(merged, evidence, now).total;

  const updated = await db
    .update(suppliers)
    .set({
      ...patch,
      score,
      updatedAt: now,
      ...(revokeVerification ? { status: 'UNDER_REVIEW' as const } : {}),
    })
    .where(eq(suppliers.id, id))
    .returning()
    .get();

  if (revokeVerification) {
    await db.insert(supplierStatusHistory).values({
      id: newId(),
      tenantId,
      supplierId: id,
      fromStatus: 'VERIFIED',
      toStatus: 'UNDER_REVIEW',
      reason: 'Cambio en condiciones comerciales: requiere nueva revisión',
      createdAt: now,
    });
  }
  return ok(toSupplierDto(updated));
};

/** Registra evidencia de verificación. Siempre entra como PENDING. */
export const recordEvidence = async (
  db: Database,
  tenantId: string,
  supplierId: string,
  input: RecordEvidenceRequest,
  now: Date,
): Promise<Result<EvidenceDto>> => {
  const supplier = await findSupplier(db, tenantId, supplierId);
  if (!supplier) return notFound('Proveedor');
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    return err(appError('VALIDATION_ERROR', 'La evidencia ya está vencida'));
  }
  const row = await db
    .insert(supplierEvidence)
    .values({
      id: newId(),
      tenantId,
      supplierId,
      category: input.category,
      description: input.description,
      reference: input.reference,
      expiresAt,
      createdAt: now,
    })
    .returning()
    .get();
  return ok(toEvidenceDto(row));
};

/** Revisa evidencia PENDING. Una evidencia ya revisada no se puede re-revisar. */
export const reviewEvidence = async (
  db: Database,
  tenantId: string,
  supplierId: string,
  evidenceId: string,
  input: ReviewEvidenceRequest,
  now: Date,
): Promise<Result<EvidenceDto>> => {
  const supplier = await findSupplier(db, tenantId, supplierId);
  if (!supplier) return notFound('Proveedor');
  const evidence = await db
    .select()
    .from(supplierEvidence)
    .where(
      and(
        eq(supplierEvidence.tenantId, tenantId),
        eq(supplierEvidence.supplierId, supplierId),
        eq(supplierEvidence.id, evidenceId),
      ),
    )
    .get();
  if (!evidence) return notFound('Evidencia');
  if (evidence.reviewStatus !== 'PENDING') {
    return err(appError('CONFLICT', 'La evidencia ya fue revisada; registrar una nueva'));
  }
  const row = await db
    .update(supplierEvidence)
    .set({ reviewStatus: input.decision, reviewNotes: nullable(input.notes), reviewedAt: now })
    .where(eq(supplierEvidence.id, evidenceId))
    .returning()
    .get();
  await refreshScore(db, supplier, now);
  return ok(toEvidenceDto(row));
};

/** Cambia el estado aplicando la máquina de estados y la regla de evidencia. */
export const changeSupplierStatus = async (
  db: Database,
  tenantId: string,
  supplierId: string,
  input: ChangeSupplierStatusRequest,
  now: Date,
): Promise<Result<SupplierDto>> => {
  const supplier = await findSupplier(db, tenantId, supplierId);
  if (!supplier) return notFound('Proveedor');
  const evidence = await listEvidence(db, tenantId, supplierId);
  const check = validateSupplierTransition(supplier, input.to, toEvidenceFacts(evidence), now);
  if (!check.ok) return check;

  const [updated] = await db.batch([
    db
      .update(suppliers)
      .set({ status: input.to, updatedAt: now })
      .where(eq(suppliers.id, supplierId))
      .returning(),
    db.insert(supplierStatusHistory).values({
      id: newId(),
      tenantId,
      supplierId,
      fromStatus: supplier.status,
      toStatus: input.to,
      reason: input.reason,
      createdAt: now,
    }),
    db.insert(auditEvents).values({
      id: newId(),
      tenantId,
      action: 'supplier.status_changed',
      entityType: 'supplier',
      entityId: supplierId,
      metadata: { from: supplier.status, to: input.to },
      dryRun: true,
      createdAt: now,
    }),
  ]);
  const row = updated[0];
  if (!row) return err(appError('INTERNAL_ERROR', 'No se pudo actualizar el proveedor'));
  return ok(toSupplierDto(row));
};

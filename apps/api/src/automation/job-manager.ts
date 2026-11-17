import { and, desc, eq, inArray } from 'drizzle-orm';
import { jobAttempts, jobs, type Database, type JobAttemptRow, type JobRow } from '@vc/database';
import { CLAIMABLE_STATUSES } from '@vc/queue';
import {
  appError,
  err,
  newId,
  ok,
  type CreateJobRequest,
  type JobAttemptDto,
  type JobDetailDto,
  type JobDto,
  type JobStatus,
  type Result,
} from '@vc/shared';
import { AuditLogger } from './audit-logger';
import { dispatchJobs } from './producer';
import { firstRow } from './rows';
import type { AutomationDeps } from './types';

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export const toJobDto = (j: JobRow): JobDto => ({
  id: j.id,
  type: j.type,
  status: j.status,
  priority: j.priority,
  payload: j.payload,
  idempotencyKey: j.idempotencyKey,
  scheduleId: j.scheduleId,
  runAt: iso(j.runAt),
  expiresAt: isoOrNull(j.expiresAt),
  attempts: j.attempts,
  maxAttempts: j.maxAttempts,
  timeoutSeconds: j.timeoutSeconds,
  lastError: j.lastError,
  lastErrorKind: j.lastErrorKind,
  result: j.result ?? null,
  startedAt: isoOrNull(j.startedAt),
  finishedAt: isoOrNull(j.finishedAt),
  createdAt: iso(j.createdAt),
  updatedAt: iso(j.updatedAt),
});

const toAttemptDto = (a: JobAttemptRow): JobAttemptDto => ({
  id: a.id,
  attempt: a.attempt,
  status: a.status,
  errorKind: a.errorKind,
  error: a.error,
  startedAt: iso(a.startedAt),
  finishedAt: isoOrNull(a.finishedAt),
  durationMs: a.durationMs,
});

const findByKey = (db: Database, tenantId: string, key: string) =>
  db
    .select()
    .from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.idempotencyKey, key)))
    .get();

export const findJob = (db: Database, tenantId: string, id: string) =>
  db
    .select()
    .from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)))
    .get();

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

export interface CreateJobOptions {
  readonly scheduleId?: string;
  /** Enviar a la cola de inmediato si ya está vencido. El Scheduler lo hace si es false. */
  readonly dispatch?: boolean;
}

/**
 * Job Manager — registra un trabajo. Idempotente: si la clave ya existe para el
 * tenant devuelve el trabajo existente (`created: false`) sin crear otro.
 * El índice único (tenant_id, idempotency_key) garantiza esto aun con carreras.
 */
export const createJob = async (
  deps: AutomationDeps,
  tenantId: string,
  input: CreateJobRequest,
  options: CreateJobOptions = {},
): Promise<Result<{ job: JobRow; created: boolean }>> => {
  const { db, clock, handlers } = deps;
  const handler = handlers.get(input.type);
  if (!handler) {
    return err(appError('VALIDATION_ERROR', `Tipo de trabajo desconocido: ${input.type}`));
  }
  const invalid = handler.validate(input.payload);
  if (invalid) return err(appError('VALIDATION_ERROR', `Payload inválido: ${invalid}`));

  const now = clock.now();
  const idempotencyKey = input.idempotencyKey ?? `auto:${newId()}`;
  const existing = await findByKey(db, tenantId, idempotencyKey);
  if (existing) return ok({ job: existing, created: false });

  const runAt = input.runAt ? new Date(input.runAt) : now;
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= runAt.getTime()) {
    return err(appError('VALIDATION_ERROR', 'expiresAt debe ser posterior a runAt'));
  }
  const status: JobStatus = runAt.getTime() > now.getTime() ? 'SCHEDULED' : 'PENDING';

  let job: JobRow;
  try {
    job = await db
      .insert(jobs)
      .values({
        id: newId(),
        tenantId,
        type: input.type,
        status,
        priority: input.priority ?? handler.defaultPriority,
        payload: input.payload,
        idempotencyKey,
        scheduleId: options.scheduleId ?? null,
        runAt,
        expiresAt,
        maxAttempts: input.maxAttempts ?? handler.defaultMaxAttempts,
        timeoutSeconds: input.timeoutSeconds ?? handler.defaultTimeoutSeconds,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findByKey(db, tenantId, idempotencyKey);
    if (!raced) throw error;
    return ok({ job: raced, created: false });
  }

  await new AuditLogger(db, clock).log({
    tenantId,
    action: 'job.created',
    entityType: 'job',
    entityId: job.id,
    metadata: { type: job.type, status: job.status, priority: job.priority },
  });

  if (status === 'PENDING' && options.dispatch !== false) {
    try {
      await dispatchJobs(db, deps.queue, [job], now);
    } catch (error) {
      // D1 ya tiene el trabajo: el Scheduler lo despachará en el próximo minuto.
      console.warn('No se pudo encolar; queda para el Scheduler', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return ok({ job, created: true });
};

export const cancelJob = async (
  deps: AutomationDeps,
  tenantId: string,
  id: string,
  reason: string,
): Promise<Result<JobRow>> => {
  const now = deps.clock.now();
  const row = await deps.db
    .update(jobs)
    .set({ status: 'CANCELLED', lastError: reason, finishedAt: now, updatedAt: now })
    .where(
      and(eq(jobs.tenantId, tenantId), eq(jobs.id, id), inArray(jobs.status, CLAIMABLE_STATUSES)),
    )
    .returning()
    .then(firstRow);
  if (!row) {
    return (await findJob(deps.db, tenantId, id))
      ? err(
          appError('CONFLICT', 'Solo se cancelan trabajos pendientes, programados o en reintento'),
        )
      : err(appError('NOT_FOUND', 'Trabajo no encontrado'));
  }
  await new AuditLogger(deps.db, deps.clock).log({
    tenantId,
    action: 'job.cancelled',
    entityType: 'job',
    entityId: id,
    metadata: { reason },
  });
  return ok(row);
};

/** Reintento manual de un trabajo FAILED o DEAD_LETTER: reinicia el contador de intentos. */
export const retryJob = async (
  deps: AutomationDeps,
  tenantId: string,
  id: string,
): Promise<Result<JobRow>> => {
  const now = deps.clock.now();
  const row = await deps.db
    .update(jobs)
    .set({
      status: 'RETRYING',
      attempts: 0,
      runAt: now,
      dispatchedAt: null,
      finishedAt: null,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.id, id),
        inArray(jobs.status, ['FAILED', 'DEAD_LETTER']),
      ),
    )
    .returning()
    .then(firstRow);
  if (!row) {
    return (await findJob(deps.db, tenantId, id))
      ? err(appError('CONFLICT', 'Solo se reintentan trabajos FAILED o DEAD_LETTER'))
      : err(appError('NOT_FOUND', 'Trabajo no encontrado'));
  }
  await new AuditLogger(deps.db, deps.clock).log({
    tenantId,
    action: 'job.manual_retry',
    entityType: 'job',
    entityId: id,
  });
  await dispatchJobs(deps.db, deps.queue, [row], now);
  return ok(row);
};

export const listJobs = async (
  db: Database,
  tenantId: string,
  status?: JobStatus,
): Promise<JobDto[]> =>
  (
    await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), status ? eq(jobs.status, status) : undefined))
      .orderBy(desc(jobs.createdAt))
      .limit(200)
  ).map(toJobDto);

export const getJobDetail = async (
  db: Database,
  tenantId: string,
  id: string,
): Promise<Result<JobDetailDto>> => {
  const job = await findJob(db, tenantId, id);
  if (!job) return err(appError('NOT_FOUND', 'Trabajo no encontrado'));
  const attempts = await db
    .select()
    .from(jobAttempts)
    .where(eq(jobAttempts.jobId, id))
    .orderBy(desc(jobAttempts.attempt), desc(jobAttempts.startedAt))
    .all();
  return ok({ job: toJobDto(job), attempts: attempts.map(toAttemptDto) });
};

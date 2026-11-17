import { and, desc, eq } from 'drizzle-orm';
import { jobSchedules, type Database, type JobScheduleRow } from '@vc/database';
import { computeNextRun, formatInTimeZone, isValidTimeZone } from '@vc/queue';
import {
  appError,
  err,
  newId,
  ok,
  type CreateScheduleRequest,
  type Result,
  type ScheduleDto,
  type UpdateScheduleRequest,
} from '@vc/shared';
import { AuditLogger } from './audit-logger';
import type { AutomationDeps } from './types';

export const toScheduleDto = (s: JobScheduleRow): ScheduleDto => ({
  id: s.id,
  name: s.name,
  jobType: s.jobType,
  payload: s.payload,
  frequency: s.frequency,
  timeZone: s.timeZone,
  enabled: s.enabled,
  priority: s.priority,
  maxAttempts: s.maxAttempts,
  timeoutSeconds: s.timeoutSeconds,
  nextRunAt: s.nextRunAt ? s.nextRunAt.toISOString() : null,
  nextRunLocal: s.nextRunAt ? formatInTimeZone(s.nextRunAt, s.timeZone) : null,
  lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null,
  lastJobId: s.lastJobId,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

export const listSchedules = async (db: Database, tenantId: string): Promise<ScheduleDto[]> =>
  (
    await db
      .select()
      .from(jobSchedules)
      .where(eq(jobSchedules.tenantId, tenantId))
      .orderBy(desc(jobSchedules.createdAt))
      .limit(200)
  ).map(toScheduleDto);

export const createSchedule = async (
  deps: AutomationDeps,
  tenantId: string,
  input: CreateScheduleRequest,
): Promise<Result<ScheduleDto>> => {
  const handler = deps.handlers.get(input.jobType);
  if (!handler)
    return err(appError('VALIDATION_ERROR', `Tipo de trabajo desconocido: ${input.jobType}`));
  const invalid = handler.validate(input.payload);
  if (invalid) return err(appError('VALIDATION_ERROR', `Payload inválido: ${invalid}`));
  if (!isValidTimeZone(input.timeZone)) {
    return err(appError('VALIDATION_ERROR', `Zona horaria inválida: ${input.timeZone}`));
  }
  const now = deps.clock.now();
  const row = await deps.db
    .insert(jobSchedules)
    .values({
      id: newId(),
      tenantId,
      name: input.name,
      jobType: input.jobType,
      payload: input.payload,
      frequency: input.frequency,
      timeZone: input.timeZone,
      enabled: input.enabled,
      priority: input.priority ?? handler.defaultPriority,
      maxAttempts: input.maxAttempts ?? handler.defaultMaxAttempts,
      timeoutSeconds: input.timeoutSeconds ?? handler.defaultTimeoutSeconds,
      nextRunAt: computeNextRun(input.frequency, input.timeZone, now),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  await new AuditLogger(deps.db, deps.clock).log({
    tenantId,
    action: 'schedule.created',
    entityType: 'schedule',
    entityId: row.id,
    metadata: { jobType: row.jobType, frequency: row.frequency, timeZone: row.timeZone },
  });
  return ok(toScheduleDto(row));
};

/** Editar frecuencia/zona o reactivar recalcula la próxima ejecución desde ahora. */
export const updateSchedule = async (
  deps: AutomationDeps,
  tenantId: string,
  id: string,
  input: UpdateScheduleRequest,
): Promise<Result<ScheduleDto>> => {
  const current = await deps.db
    .select()
    .from(jobSchedules)
    .where(and(eq(jobSchedules.tenantId, tenantId), eq(jobSchedules.id, id)))
    .get();
  if (!current) return err(appError('NOT_FOUND', 'Programación no encontrada'));
  if (input.timeZone && !isValidTimeZone(input.timeZone)) {
    return err(appError('VALIDATION_ERROR', `Zona horaria inválida: ${input.timeZone}`));
  }
  if (input.payload) {
    const invalid = deps.handlers.get(current.jobType)?.validate(input.payload);
    if (invalid) return err(appError('VALIDATION_ERROR', `Payload inválido: ${invalid}`));
  }
  const now = deps.clock.now();
  const frequency = input.frequency ?? current.frequency;
  const timeZone = input.timeZone ?? current.timeZone;
  const recompute =
    input.frequency !== undefined ||
    input.timeZone !== undefined ||
    (input.enabled === true && !current.enabled);

  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const row = await deps.db
    .update(jobSchedules)
    .set({
      ...patch,
      ...(recompute ? { nextRunAt: computeNextRun(frequency, timeZone, now) } : {}),
      updatedAt: now,
    })
    .where(eq(jobSchedules.id, id))
    .returning()
    .get();
  await new AuditLogger(deps.db, deps.clock).log({
    tenantId,
    action: 'schedule.updated',
    entityType: 'schedule',
    entityId: id,
    metadata: { changes: Object.keys(patch) },
  });
  return ok(toScheduleDto(row));
};

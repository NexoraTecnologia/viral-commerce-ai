import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { jobSchedules, jobs } from '@vc/database';
import { CLAIMABLE_STATUSES, computeNextRun } from '@vc/queue';
import { newId, type TickResultDto } from '@vc/shared';
import { AuditLogger } from './audit-logger';
import { createJob } from './job-manager';
import { withLock } from './locks';
import { dispatchJobs } from './producer';
import { AUTOMATION_TIMINGS, type AutomationDeps } from './types';

/**
 * SCHEDULER CENTRAL — único Cron Trigger de ejecución (cada minuto, UTC).
 * No hay un cron por agente: todas las frecuencias viven en D1 (`job_schedules`).
 *
 *  1. Materializa programaciones vencidas en trabajos. La clave de idempotencia
 *     `schedule:<id>:<instante planificado>` impide duplicados aunque dos ticks
 *     se solapen. Si una programación está muy atrasada (Worker caído), corre
 *     UNA vez y la próxima se calcula desde ahora (sin ráfagas de recuperación).
 *  2. Cancela trabajos vencidos (`expires_at`) que nunca empezaron.
 *  3. Despacha a la cola los trabajos listos, en orden de prioridad.
 */
export const runSchedulerTick = async (deps: AutomationDeps): Promise<TickResultDto> => {
  const { db, clock } = deps;
  const now = clock.now();
  const audit = new AuditLogger(db, clock);

  const locked = await withLock(
    db,
    'scheduler',
    newId(),
    now,
    AUTOMATION_TIMINGS.schedulerLockMs,
    async () => {
      let materialized = 0;
      let misfires = 0;
      let scheduleErrors = 0;

      const dueSchedules = await db
        .select()
        .from(jobSchedules)
        .where(and(eq(jobSchedules.enabled, true), lte(jobSchedules.nextRunAt, now)))
        .orderBy(asc(jobSchedules.priority), asc(jobSchedules.nextRunAt))
        .limit(AUTOMATION_TIMINGS.batchSize);

      for (const s of dueSchedules) {
        const plannedAt = s.nextRunAt ?? now;
        const created = await createJob(
          deps,
          s.tenantId,
          {
            type: s.jobType,
            payload: s.payload,
            priority: s.priority,
            maxAttempts: s.maxAttempts,
            timeoutSeconds: s.timeoutSeconds,
            idempotencyKey: `schedule:${s.id}:${plannedAt.toISOString()}`,
            // Mismo instante que el resto del tick: si createJob leyera el reloj de nuevo,
            // run_at quedaría unos ms en el futuro y este mismo tick no lo despacharía.
            runAt: now.toISOString(),
          },
          { scheduleId: s.id, dispatch: false },
        );
        const nextRunAt = computeNextRun(s.frequency, s.timeZone, now);
        await db
          .update(jobSchedules)
          .set({
            nextRunAt,
            lastRunAt: now,
            ...(created.ok ? { lastJobId: created.value.job.id } : {}),
            updatedAt: now,
          })
          .where(eq(jobSchedules.id, s.id));

        if (!created.ok) {
          scheduleErrors++;
          await audit.log({
            tenantId: s.tenantId,
            action: 'schedule.error',
            entityType: 'schedule',
            entityId: s.id,
            metadata: { error: created.error.message },
          });
          continue;
        }
        if (created.value.created) materialized++;
        if (now.getTime() - plannedAt.getTime() > AUTOMATION_TIMINGS.misfireGraceMs) {
          misfires++;
          await audit.log({
            tenantId: s.tenantId,
            action: 'schedule.misfire',
            entityType: 'schedule',
            entityId: s.id,
            metadata: { plannedAt: plannedAt.toISOString(), nextRunAt: nextRunAt.toISOString() },
          });
        }
      }

      const expired = await db
        .update(jobs)
        .set({ status: 'CANCELLED', lastError: 'EXPIRED', finishedAt: now, updatedAt: now })
        .where(and(inArray(jobs.status, CLAIMABLE_STATUSES), lte(jobs.expiresAt, now)))
        .returning({ id: jobs.id, tenantId: jobs.tenantId });
      for (const e of expired) {
        await audit.log({
          tenantId: e.tenantId,
          action: 'job.expired',
          entityType: 'job',
          entityId: e.id,
        });
      }

      const redispatchBefore = new Date(now.getTime() - AUTOMATION_TIMINGS.redispatchAfterMs);
      const ready = await db
        .select({ id: jobs.id, tenantId: jobs.tenantId, priority: jobs.priority })
        .from(jobs)
        .where(
          and(
            inArray(jobs.status, CLAIMABLE_STATUSES),
            lte(jobs.runAt, now),
            or(isNull(jobs.dispatchedAt), lte(jobs.dispatchedAt, redispatchBefore)),
          ),
        )
        .orderBy(asc(jobs.priority), asc(jobs.runAt))
        .limit(AUTOMATION_TIMINGS.batchSize);
      const dispatched = await dispatchJobs(db, deps.queue, ready, now);

      return { materialized, misfires, scheduleErrors, expired: expired.length, dispatched };
    },
  );

  return locked.acquired ? { ran: true, detail: locked.value } : { ran: false, detail: {} };
};

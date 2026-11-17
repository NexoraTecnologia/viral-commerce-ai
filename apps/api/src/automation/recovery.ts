import { and, asc, eq, inArray, isNotNull, isNull, lt, lte } from 'drizzle-orm';
import { jobAttempts, jobSchedules, jobs, locks } from '@vc/database';
import { CLAIMABLE_STATUSES, computeNextRun } from '@vc/queue';
import { newId, type TickResultDto } from '@vc/shared';
import { AuditLogger } from './audit-logger';
import { withLock } from './locks';
import { dispatchJobs } from './producer';
import { firstRow } from './rows';
import { AUTOMATION_TIMINGS, type AutomationDeps } from './types';

/**
 * RECOVERY WORKER — segundo y último Cron Trigger (cada 5 minutos, UTC).
 * Recupera el sistema desde D1, sin depender de la retención de la cola:
 *
 *  1. Trabajos RUNNING con lease vencido (Worker caído o colgado): vuelven a
 *     RETRYING si les quedan intentos, o pasan a DEAD_LETTER.
 *  2. Trabajos listos cuyo mensaje se despachó hace mucho y nunca corrió
 *     (mensaje perdido o expirado): se re-envían a la cola.
 *  3. Programaciones activas sin próxima ejecución: se recalculan.
 *  4. Locks vencidos: se limpian.
 */
export const runRecoveryTick = async (deps: AutomationDeps): Promise<TickResultDto> => {
  const { db, clock } = deps;
  const now = clock.now();
  const audit = new AuditLogger(db, clock);

  const locked = await withLock(
    db,
    'recovery',
    newId(),
    now,
    AUTOMATION_TIMINGS.recoveryLockMs,
    async () => {
      let recovered = 0;
      let deadLettered = 0;

      const stuck = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, 'RUNNING'), lt(jobs.lockedUntil, now)))
        .limit(AUTOMATION_TIMINGS.batchSize);

      for (const j of stuck) {
        const exhausted = j.attempts >= j.maxAttempts;
        const row = await db
          .update(jobs)
          .set({
            status: exhausted ? 'DEAD_LETTER' : 'RETRYING',
            lockedBy: null,
            lockedUntil: null,
            lastError: 'Interrumpido: lease vencido sin resultado',
            lastErrorKind: 'TIMEOUT',
            updatedAt: now,
            ...(exhausted ? { finishedAt: now } : { runAt: now, dispatchedAt: null }),
          })
          .where(
            and(
              eq(jobs.id, j.id),
              eq(jobs.status, 'RUNNING'),
              lt(jobs.lockedUntil, now),
              j.lockedBy ? eq(jobs.lockedBy, j.lockedBy) : isNull(jobs.lockedBy),
            ),
          )
          .returning()
          .then(firstRow);
        if (!row) continue;
        await db
          .update(jobAttempts)
          .set({
            status: 'INTERRUPTED',
            errorKind: 'TIMEOUT',
            error: 'Lease vencido',
            finishedAt: now,
          })
          .where(and(eq(jobAttempts.jobId, j.id), eq(jobAttempts.status, 'RUNNING')));
        if (exhausted) deadLettered++;
        else recovered++;
        await audit.log({
          tenantId: j.tenantId,
          action: exhausted ? 'job.dead_letter' : 'job.recovered',
          entityType: 'job',
          entityId: j.id,
          metadata: { attempts: j.attempts, maxAttempts: j.maxAttempts },
        });
      }

      const lostBefore = new Date(now.getTime() - AUTOMATION_TIMINGS.lostMessageAfterMs);
      const lost = await db
        .select({ id: jobs.id, tenantId: jobs.tenantId, priority: jobs.priority })
        .from(jobs)
        .where(
          and(
            inArray(jobs.status, CLAIMABLE_STATUSES),
            lte(jobs.runAt, now),
            isNotNull(jobs.dispatchedAt),
            lt(jobs.dispatchedAt, lostBefore),
          ),
        )
        .orderBy(asc(jobs.priority), asc(jobs.runAt))
        .limit(AUTOMATION_TIMINGS.batchSize);
      const redispatched = await dispatchJobs(db, deps.queue, lost, now);

      const orphanSchedules = await db
        .select()
        .from(jobSchedules)
        .where(and(eq(jobSchedules.enabled, true), isNull(jobSchedules.nextRunAt)))
        .limit(AUTOMATION_TIMINGS.batchSize);
      for (const s of orphanSchedules) {
        await db
          .update(jobSchedules)
          .set({ nextRunAt: computeNextRun(s.frequency, s.timeZone, now), updatedAt: now })
          .where(eq(jobSchedules.id, s.id));
      }

      // El lock propio de recovery se libera al salir; aquí solo se limpian los vencidos ajenos.
      const cleaned = await db
        .delete(locks)
        .where(lt(locks.expiresAt, now))
        .returning({ name: locks.name });

      return {
        recovered,
        deadLettered,
        redispatched,
        schedulesFixed: orphanSchedules.length,
        locksCleaned: cleaned.length,
      };
    },
  );

  return locked.acquired ? { ran: true, detail: locked.value } : { ran: false, detail: {} };
};

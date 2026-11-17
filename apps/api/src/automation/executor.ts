import { and, eq, inArray, lte } from 'drizzle-orm';
import { jobAttempts, jobs, type JobRow } from '@vc/database';
import {
  breakerDecision,
  breakerOnFailure,
  breakerOnSuccess,
  classifyJobError,
  CLAIMABLE_STATUSES,
  computeBackoffMs,
  errorText,
  isTerminal,
  PermanentJobError,
  withTimeout,
  type JobErrorKind,
} from '@vc/queue';
import { newId } from '@vc/shared';
import { AuditLogger } from './audit-logger';
import { breakerKeyForJob, loadBreaker, saveBreaker } from './breaker-store';
import { dispatchJobs } from './producer';
import { firstRow } from './rows';
import { AUTOMATION_TIMINGS, type AutomationDeps } from './types';

export type ExecutionOutcome =
  | 'COMPLETED'
  | 'FAILED'
  | 'RETRYING'
  | 'DEAD_LETTER'
  | 'EXPIRED'
  | 'DEFERRED'
  | 'SKIPPED'
  | 'MISSING';

export interface ExecutionResult {
  readonly outcome: ExecutionOutcome;
  readonly job?: JobRow;
}

/**
 * Ejecuta UN trabajo de punta a punta. Es el núcleo del Queue Consumer y del
 * Retry Manager:
 *
 *  1. Ignora mensajes duplicados o tardíos (trabajo ya terminado o en curso).
 *  2. Cancela trabajos vencidos (`expiresAt`) sin ejecutarlos.
 *  3. Respeta el circuit breaker del tipo de trabajo.
 *  4. Toma el lock con UPDATE condicional (compare-and-set): solo un ejecutor gana.
 *  5. Ejecuta con timeout.
 *  6. Éxito → COMPLETED. Error permanente → FAILED. Recuperable/timeout →
 *     RETRYING con backoff, o DEAD_LETTER al agotar intentos.
 *
 * Las escrituras finales exigen que el lock siga siendo nuestro: si el Recovery
 * Worker recuperó el trabajo mientras tanto, el resultado tardío se descarta.
 */
export const executeJob = async (deps: AutomationDeps, jobId: string): Promise<ExecutionResult> => {
  const { db, clock, handlers, config } = deps;
  const audit = new AuditLogger(db, clock);
  const now = clock.now();

  const job = await db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return { outcome: 'MISSING' };
  if (isTerminal(job.status) || job.status === 'RUNNING') return { outcome: 'SKIPPED', job };
  if (job.runAt.getTime() > now.getTime()) return { outcome: 'SKIPPED', job };

  // Tarea vencida: no se ejecuta.
  if (job.expiresAt && job.expiresAt.getTime() <= now.getTime()) {
    const expired = await db
      .update(jobs)
      .set({ status: 'CANCELLED', lastError: 'EXPIRED', finishedAt: now, updatedAt: now })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, CLAIMABLE_STATUSES)))
      .returning()
      .then(firstRow);
    if (expired) {
      await audit.log({
        tenantId: job.tenantId,
        action: 'job.expired',
        entityType: 'job',
        entityId: jobId,
      });
    }
    return { outcome: expired ? 'EXPIRED' : 'SKIPPED', ...(expired ? { job: expired } : {}) };
  }

  // Circuit breaker.
  const breakerKey = breakerKeyForJob(job.type);
  const decision = breakerDecision(await loadBreaker(db, job.tenantId, breakerKey), now);
  if (!decision.allowed) {
    const deferred = await db
      .update(jobs)
      .set({
        status: 'RETRYING',
        runAt: decision.retryAt,
        dispatchedAt: null,
        lastError: 'CIRCUIT_OPEN',
        updatedAt: now,
      })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, CLAIMABLE_STATUSES)))
      .returning()
      .then(firstRow);
    return { outcome: deferred ? 'DEFERRED' : 'SKIPPED', ...(deferred ? { job: deferred } : {}) };
  }

  // Lock (compare-and-set).
  const lockToken = newId();
  const leaseMs = job.timeoutSeconds * 1000 + AUTOMATION_TIMINGS.leaseGraceMs;
  const claimed = await db
    .update(jobs)
    .set({
      status: 'RUNNING',
      attempts: job.attempts + 1,
      lockedBy: lockToken,
      lockedUntil: new Date(now.getTime() + leaseMs),
      startedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.attempts, job.attempts),
        inArray(jobs.status, CLAIMABLE_STATUSES),
        lte(jobs.runAt, now),
      ),
    )
    .returning()
    .then(firstRow);
  if (!claimed) return { outcome: 'SKIPPED', job };

  const attemptId = newId();
  await db.insert(jobAttempts).values({
    id: attemptId,
    jobId,
    attempt: claimed.attempts,
    workerId: deps.workerId,
    status: 'RUNNING',
    startedAt: now,
  });

  const ownLock = and(eq(jobs.id, jobId), eq(jobs.status, 'RUNNING'), eq(jobs.lockedBy, lockToken));
  const handler = handlers.get(job.type);

  let result: unknown;
  let failure: { kind: JobErrorKind; message: string } | null = null;
  try {
    if (!handler) throw new PermanentJobError(`Sin handler registrado para ${job.type}`);
    result = await withTimeout(
      () =>
        handler.run(
          {
            db,
            tenantId: job.tenantId,
            jobId,
            attempt: claimed.attempts,
            config,
            now,
            audit,
            secrets: deps.secrets ?? {},
          },
          job.payload,
        ),
      job.timeoutSeconds * 1000,
      (ms) => clock.sleep(ms),
    );
  } catch (error) {
    failure = { kind: classifyJobError(error), message: errorText(error) };
  }

  const finishedAt = clock.now();
  const durationMs = finishedAt.getTime() - now.getTime();
  const release = { lockedBy: null, lockedUntil: null, updatedAt: finishedAt };

  if (!failure) {
    const done = await db
      .update(jobs)
      .set({
        ...release,
        status: 'COMPLETED',
        result: result ?? null,
        lastError: null,
        lastErrorKind: null,
        finishedAt,
      })
      .where(ownLock)
      .returning()
      .then(firstRow);
    if (!done) return discardStale(deps, job, attemptId, finishedAt);
    await db
      .update(jobAttempts)
      .set({ status: 'SUCCEEDED', finishedAt, durationMs })
      .where(eq(jobAttempts.id, attemptId));
    if (decision.state.state !== 'CLOSED' || decision.state.consecutiveFailures > 0) {
      await saveBreaker(db, job.tenantId, breakerKey, breakerOnSuccess(), finishedAt);
    }
    await audit.log({
      tenantId: job.tenantId,
      action: 'job.completed',
      entityType: 'job',
      entityId: jobId,
      metadata: { type: job.type, attempt: claimed.attempts, durationMs },
    });
    return { outcome: 'COMPLETED', job: done };
  }

  await db
    .update(jobAttempts)
    .set({
      status: 'FAILED',
      errorKind: failure.kind,
      error: failure.message,
      finishedAt,
      durationMs,
    })
    .where(eq(jobAttempts.id, attemptId));

  // Las fallas de datos (permanentes) no indican una dependencia caída.
  if (failure.kind !== 'PERMANENT') {
    const next = breakerOnFailure(decision.state, finishedAt, deps.breaker);
    await saveBreaker(db, job.tenantId, breakerKey, next, finishedAt);
  }

  const exhausted = claimed.attempts >= claimed.maxAttempts;
  const outcome: ExecutionOutcome =
    failure.kind === 'PERMANENT' ? 'FAILED' : exhausted ? 'DEAD_LETTER' : 'RETRYING';
  const backoffMs =
    outcome === 'RETRYING' ? computeBackoffMs(claimed.attempts, jobId, deps.backoff) : 0;
  const retryAt = new Date(finishedAt.getTime() + backoffMs);

  const updated = await db
    .update(jobs)
    .set({
      ...release,
      status: outcome,
      lastError: failure.message,
      lastErrorKind: failure.kind,
      ...(outcome === 'RETRYING' ? { runAt: retryAt, dispatchedAt: null } : { finishedAt }),
    })
    .where(ownLock)
    .returning()
    .then(firstRow);
  if (!updated) return discardStale(deps, job, attemptId, finishedAt);

  await audit.log({
    tenantId: job.tenantId,
    action: `job.${outcome.toLowerCase()}`,
    entityType: 'job',
    entityId: jobId,
    metadata: {
      type: job.type,
      attempt: claimed.attempts,
      maxAttempts: claimed.maxAttempts,
      errorKind: failure.kind,
      error: failure.message,
      ...(outcome === 'RETRYING' ? { retryAt: retryAt.toISOString() } : {}),
    },
  });

  if (outcome === 'RETRYING') {
    try {
      await dispatchJobs(db, deps.queue, [updated], finishedAt, backoffMs / 1000);
    } catch {
      // El Scheduler lo re-despacha cuando venza `run_at`.
    }
  }
  return { outcome, job: updated };
};

/** El lock ya no es nuestro (recuperado por timeout): se descarta el resultado tardío. */
const discardStale = async (
  deps: AutomationDeps,
  job: JobRow,
  attemptId: string,
  finishedAt: Date,
): Promise<ExecutionResult> => {
  await deps.db
    .update(jobAttempts)
    .set({ status: 'INTERRUPTED', error: 'Lock perdido: resultado descartado', finishedAt })
    .where(eq(jobAttempts.id, attemptId));
  await new AuditLogger(deps.db, deps.clock).log({
    tenantId: job.tenantId,
    action: 'job.stale_result_discarded',
    entityType: 'job',
    entityId: job.id,
  });
  return { outcome: 'SKIPPED' };
};

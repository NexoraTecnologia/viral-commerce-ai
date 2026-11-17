import { and, eq, inArray } from 'drizzle-orm';
import { createDb, jobs } from '@vc/database';
import { parseQueueMessage } from '@vc/queue';
import { newId, parseApiConfig } from '@vc/shared';
import { secretsFromEnv, type Env } from '../env';
import { AuditLogger } from './audit-logger';
import { executeJob } from './executor';
import { defaultHandlers } from './handlers';
import { runRecoveryTick } from './recovery';
import { runSchedulerTick } from './scheduler';
import {
  JOBS_DLQ_NAME,
  RECOVERY_CRON,
  SCHEDULER_CRON,
  systemClock,
  type AutomationDeps,
  type Clock,
  type HandlerRegistry,
} from './types';
import { firstRow } from './rows';

/** Mensaje mínimo que necesita el consumidor (subconjunto de `Message` de Workers). */
export interface ConsumedMessage {
  readonly id: string;
  readonly body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ConsumedBatch {
  readonly queue: string;
  readonly messages: readonly ConsumedMessage[];
}

export const automationDepsFromEnv = (
  env: Env,
  overrides: { clock?: Clock; handlers?: HandlerRegistry } = {},
): AutomationDeps => ({
  db: createDb(env.DB),
  queue: env.JOBS_QUEUE,
  clock: overrides.clock ?? systemClock,
  handlers: overrides.handlers ?? defaultHandlers,
  config: parseApiConfig({ ...env }),
  workerId: `worker:${newId()}`,
  secrets: secretsFromEnv(env),
});

/**
 * Queue Consumer. La cola solo transporta punteros; el estado vive en D1.
 *  - Ordena cada lote por prioridad (eventos comerciales primero).
 *  - `ack` después de registrar el resultado en D1 (éxito o falla del trabajo).
 *  - `retry` solo si falla la infraestructura (p. ej. D1 no responde). Tras
 *    `max_retries`, Cloudflare mueve el mensaje a la DLQ.
 *  - Mensajes de la DLQ: marcan el trabajo como DEAD_LETTER en D1.
 */
export const handleQueueBatch = async (
  deps: AutomationDeps,
  batch: ConsumedBatch,
): Promise<void> => {
  const audit = new AuditLogger(deps.db, deps.clock);
  const parsed = batch.messages.map((m) => ({ m, p: parseQueueMessage(m.body) }));
  const priorityOf = (x: (typeof parsed)[number]) =>
    x.p.success && x.p.data.type === 'job.execute' ? x.p.data.payload.priority : 100;
  parsed.sort((a, b) => priorityOf(a) - priorityOf(b));

  for (const { m, p } of parsed) {
    if (!p.success) {
      console.warn('Mensaje inválido descartado', { id: m.id });
      m.ack();
      continue;
    }
    const message = p.data;
    if (message.type === 'system.ping') {
      console.info('system.ping recibido', { id: message.id });
      m.ack();
      continue;
    }
    try {
      if (batch.queue === JOBS_DLQ_NAME) {
        const now = deps.clock.now();
        const row = await deps.db
          .update(jobs)
          .set({
            status: 'DEAD_LETTER',
            lastError: 'Mensaje agotó reintentos de la cola (DLQ)',
            finishedAt: now,
            lockedBy: null,
            lockedUntil: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(jobs.id, message.payload.jobId),
              inArray(jobs.status, ['PENDING', 'SCHEDULED', 'RETRYING']),
            ),
          )
          .returning({ id: jobs.id, tenantId: jobs.tenantId })
          .then(firstRow);
        if (row) {
          await audit.log({
            tenantId: row.tenantId,
            action: 'job.dead_letter',
            entityType: 'job',
            entityId: row.id,
            metadata: { source: 'queue_dlq' },
          });
        }
      } else {
        await executeJob(deps, message.payload.jobId);
      }
      m.ack();
    } catch (error) {
      console.error('Fallo de infraestructura procesando mensaje; se reintenta', {
        id: m.id,
        error: error instanceof Error ? error.message : String(error),
      });
      m.retry({ delaySeconds: 30 });
    }
  }
};

/**
 * ORCHESTRATOR: punto de entrada único de la automatización. Solo existen dos
 * Cron Triggers (UTC): Scheduler (cada minuto) y Recovery Worker (cada 5 min).
 */
export const handleCron = async (deps: AutomationDeps, cron: string) => {
  if (cron === SCHEDULER_CRON) return runSchedulerTick(deps);
  if (cron === RECOVERY_CRON) return runRecoveryTick(deps);
  console.warn('Cron Trigger desconocido', { cron });
  return { ran: false, detail: {} };
};

export const CRON_TRIGGERS = [
  { name: 'Scheduler', expression: SCHEDULER_CRON },
  { name: 'Recovery Worker', expression: RECOVERY_CRON },
];

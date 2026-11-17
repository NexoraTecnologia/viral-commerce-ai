import { inArray } from 'drizzle-orm';
import { jobs, type Database } from '@vc/database';
import { createMessage } from '@vc/queue';
import type { QueuePort } from './types';

export interface DispatchTarget {
  readonly id: string;
  readonly tenantId: string;
  readonly priority: number;
}

/** Cloudflare Queues admite hasta 100 mensajes por sendBatch; D1, ~100 parámetros por consulta. */
const CHUNK = 90;
const MAX_DELAY_SECONDS = 12 * 3600;

/**
 * Queue Producer: envía punteros `job.execute` ordenados por prioridad (los
 * eventos comerciales primero) y registra `dispatched_at` en D1. Las colas no
 * tienen prioridad nativa: la prioridad se aplica al despachar y al consumir.
 */
export const dispatchJobs = async (
  db: Database,
  queue: QueuePort,
  targets: readonly DispatchTarget[],
  now: Date,
  delaySeconds = 0,
): Promise<number> => {
  const sorted = [...targets].sort((a, b) => a.priority - b.priority);
  const delay = Math.max(0, Math.min(MAX_DELAY_SECONDS, Math.ceil(delaySeconds)));
  for (let i = 0; i < sorted.length; i += CHUNK) {
    const chunk = sorted.slice(i, i + CHUNK);
    await queue.sendBatch(
      chunk.map((t) => ({
        body: createMessage('job.execute', {
          jobId: t.id,
          tenantId: t.tenantId,
          priority: t.priority,
        }),
        ...(delay > 0 ? { delaySeconds: delay } : {}),
      })),
    );
    await db
      .update(jobs)
      .set({ dispatchedAt: now })
      .where(
        inArray(
          jobs.id,
          chunk.map((t) => t.id),
        ),
      );
  }
  return sorted.length;
};

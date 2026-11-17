import type { z } from 'zod';
import type { Database } from '@vc/database';
import {
  PermanentJobError,
  type BackoffPolicy,
  type BreakerPolicy,
  type QueueMessage,
} from '@vc/queue';
import type { ApiConfig, JobCategory } from '@vc/shared';
import type { ChannelSecrets } from '../env';
import type { AuditLogger } from './audit-logger';

/** Reloj inyectable: en producción el del Worker (UTC); en tests, uno controlado. */
export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** Subconjunto de la API de Cloudflare Queues que usa el productor. */
export interface QueuePort {
  sendBatch(messages: { body: QueueMessage; delaySeconds?: number }[]): Promise<unknown>;
}

export interface JobHandlerContext {
  readonly db: Database;
  readonly tenantId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly config: ApiConfig;
  readonly now: Date;
  readonly audit: AuditLogger;
  /** Secrets de integraciones (vacío si no hay ninguno configurado). */
  readonly secrets: ChannelSecrets;
}

/** Definición de un tipo de trabajo ("agente"). Todos comparten el Scheduler central. */
export interface JobHandler {
  readonly type: string;
  readonly category: JobCategory;
  readonly description: string;
  readonly defaultPriority: number;
  readonly defaultMaxAttempts: number;
  readonly defaultTimeoutSeconds: number;
  /** Devuelve null si el payload es válido; si no, el motivo. */
  validate(payload: unknown): string | null;
  run(ctx: JobHandlerContext, payload: unknown): Promise<unknown>;
}

export type HandlerRegistry = ReadonlyMap<string, JobHandler>;

export const defineHandler = <S extends z.ZodType>(def: {
  type: string;
  category: JobCategory;
  description: string;
  defaultPriority: number;
  defaultMaxAttempts: number;
  defaultTimeoutSeconds: number;
  payloadSchema: S;
  run: (ctx: JobHandlerContext, payload: z.output<S>) => Promise<unknown>;
}): JobHandler => ({
  type: def.type,
  category: def.category,
  description: def.description,
  defaultPriority: def.defaultPriority,
  defaultMaxAttempts: def.defaultMaxAttempts,
  defaultTimeoutSeconds: def.defaultTimeoutSeconds,
  validate: (payload) => {
    const parsed = def.payloadSchema.safeParse(payload);
    return parsed.success ? null : parsed.error.issues.map((i) => i.message).join('; ');
  },
  run: (ctx, payload) => {
    const parsed = def.payloadSchema.safeParse(payload);
    if (!parsed.success) throw new PermanentJobError(`Payload inválido: ${parsed.error.message}`);
    return def.run(ctx, parsed.data);
  },
});

export const registryOf = (handlers: readonly JobHandler[]): HandlerRegistry =>
  new Map(handlers.map((h) => [h.type, h]));

export interface AutomationDeps {
  readonly db: Database;
  readonly queue: QueuePort;
  readonly clock: Clock;
  readonly handlers: HandlerRegistry;
  readonly config: ApiConfig;
  /** Identificador de esta invocación del Worker (para locks y auditoría). */
  readonly workerId: string;
  readonly backoff?: BackoffPolicy;
  readonly breaker?: BreakerPolicy;
  readonly secrets?: ChannelSecrets;
}

/** Tiempos operativos del motor. */
export const AUTOMATION_TIMINGS = {
  /** Margen extra sobre el timeout antes de considerar un trabajo interrumpido. */
  leaseGraceMs: 30_000,
  /** No re-enviar a la cola un trabajo despachado hace menos de esto. */
  redispatchAfterMs: 5 * 60_000,
  /** El Recovery Worker considera perdido un mensaje despachado hace más de esto. */
  lostMessageAfterMs: 15 * 60_000,
  /** Una programación atrasada más que esto se registra como "misfire". */
  misfireGraceMs: 10 * 60_000,
  schedulerLockMs: 55_000,
  recoveryLockMs: 4 * 60_000,
  batchSize: 100,
} as const;

export const SCHEDULER_CRON = '* * * * *';
export const RECOVERY_CRON = '*/5 * * * *';
export const JOBS_DLQ_NAME = 'viralcommerce-jobs-dlq';

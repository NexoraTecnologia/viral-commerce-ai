import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { ScheduleFrequency } from '@vc/shared';
import { epochMsDefault, timestamps } from '../columns';
import { tenants } from '../schema';

const JOB_STATUS = [
  'PENDING',
  'SCHEDULED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'RETRYING',
  'CANCELLED',
  'DEAD_LETTER',
] as const;
const ERROR_KIND = ['RECOVERABLE', 'PERMANENT', 'TIMEOUT'] as const;

/**
 * Programaciones: frecuencias almacenadas en D1 y editables desde el dashboard.
 * Un único Cron Trigger (Scheduler) las materializa en trabajos.
 */
export const jobSchedules = sqliteTable(
  'job_schedules',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    jobType: text('job_type').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    frequency: text('frequency', { mode: 'json' }).$type<ScheduleFrequency>().notNull(),
    timeZone: text('time_zone').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    priority: integer('priority').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    timeoutSeconds: integer('timeout_seconds').notNull(),
    nextRunAt: integer('next_run_at', { mode: 'timestamp_ms' }),
    lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
    lastJobId: text('last_job_id'),
    ...timestamps,
  },
  (t) => [index('job_schedules_due_idx').on(t.enabled, t.nextRunAt)],
);

/** Trabajos: D1 es la fuente de verdad; la cola solo transporta punteros. */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    status: text('status', { enum: JOB_STATUS }).notNull(),
    /** Menor = más urgente. */
    priority: integer('priority').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    scheduleId: text('schedule_id').references(() => jobSchedules.id, { onDelete: 'set null' }),
    runAt: integer('run_at', { mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    timeoutSeconds: integer('timeout_seconds').notNull(),
    /** Lock de ejecución (lease): quién lo tiene y hasta cuándo. */
    lockedBy: text('locked_by'),
    lockedUntil: integer('locked_until', { mode: 'timestamp_ms' }),
    /** Último envío a la cola; permite re-despachar mensajes perdidos. */
    dispatchedAt: integer('dispatched_at', { mode: 'timestamp_ms' }),
    lastError: text('last_error'),
    lastErrorKind: text('last_error_kind', { enum: ERROR_KIND }),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('jobs_tenant_idempotency_uq').on(t.tenantId, t.idempotencyKey),
    index('jobs_dispatch_idx').on(t.status, t.priority, t.runAt),
    index('jobs_lock_idx').on(t.status, t.lockedUntil),
    index('jobs_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
);

/** Historial de intentos (resultado, error y duración de cada ejecución). */
export const jobAttempts = sqliteTable(
  'job_attempts',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    workerId: text('worker_id').notNull(),
    status: text('status', { enum: ['RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED'] }).notNull(),
    errorKind: text('error_kind', { enum: ERROR_KIND }),
    error: text('error'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    durationMs: integer('duration_ms'),
  },
  (t) => [index('job_attempts_job_idx').on(t.jobId, t.attempt)],
);

/** Estado de circuit breakers por tenant y clave (tipo de trabajo). */
export const circuitBreakers = sqliteTable(
  'circuit_breakers',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    state: text('state', { enum: ['CLOSED', 'OPEN', 'HALF_OPEN'] }).notNull(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    openUntil: integer('open_until', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(epochMsDefault),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

/** Locks globales con vencimiento (Scheduler y Recovery no corren en paralelo). */
export const locks = sqliteTable('locks', {
  name: text('name').primaryKey(),
  holder: text('holder').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

export type JobRow = typeof jobs.$inferSelect;
export type JobAttemptRow = typeof jobAttempts.$inferSelect;
export type JobScheduleRow = typeof jobSchedules.$inferSelect;
export type CircuitBreakerRow = typeof circuitBreakers.$inferSelect;

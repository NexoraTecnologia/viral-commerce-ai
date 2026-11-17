import { z } from 'zod';
import { IsoDateTimeSchema } from './common';

export const JobStatusSchema = z.enum([
  'PENDING',
  'SCHEDULED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'RETRYING',
  'CANCELLED',
  'DEAD_LETTER',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Categoría del trabajo. COMMERCIAL tiene prioridad sobre el resto. */
export const JobCategorySchema = z.enum(['COMMERCIAL', 'MAINTENANCE', 'SYSTEM']);
export type JobCategory = z.infer<typeof JobCategorySchema>;

export const JobErrorKindSchema = z.enum(['RECOVERABLE', 'PERMANENT', 'TIMEOUT']);

/** Tipo de trabajo: identificador "dominio.accion". */
export const JobTypeNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'Formato dominio.accion');

const PrioritySchema = z.number().int().min(0).max(100);

export const CreateJobRequestSchema = z.object({
  type: JobTypeNameSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Menor = más urgente. Si se omite, se usa la prioridad del tipo. */
  priority: PrioritySchema.optional(),
  /** Si se omite, se ejecuta lo antes posible. */
  runAt: IsoDateTimeSchema.optional(),
  /** Después de esta fecha el trabajo ya no tiene sentido y se cancela sin ejecutar. */
  expiresAt: IsoDateTimeSchema.optional(),
  /** Misma clave = mismo trabajo (no se duplica). */
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  timeoutSeconds: z.number().int().min(1).max(900).optional(),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export const JobDtoSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  status: JobStatusSchema,
  priority: z.number().int(),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string(),
  scheduleId: z.uuid().nullable(),
  runAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema.nullable(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  timeoutSeconds: z.number().int(),
  lastError: z.string().nullable(),
  lastErrorKind: JobErrorKindSchema.nullable(),
  result: z.unknown().nullable(),
  startedAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type JobDto = z.infer<typeof JobDtoSchema>;

export const JobAttemptDtoSchema = z.object({
  id: z.uuid(),
  attempt: z.number().int(),
  status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED']),
  errorKind: JobErrorKindSchema.nullable(),
  error: z.string().nullable(),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
  durationMs: z.number().int().nullable(),
});
export type JobAttemptDto = z.infer<typeof JobAttemptDtoSchema>;

export const JobDetailDtoSchema = z.object({
  job: JobDtoSchema,
  attempts: z.array(JobAttemptDtoSchema),
});
export type JobDetailDto = z.infer<typeof JobDetailDtoSchema>;

export const CreateJobResponseSchema = z.object({
  job: JobDtoSchema,
  /** false si ya existía un trabajo con la misma clave de idempotencia. */
  created: z.boolean(),
});
export type CreateJobResponse = z.infer<typeof CreateJobResponseSchema>;

/* ---------- Programaciones ---------- */

const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora local HH:MM (24 h)');

export const ScheduleFrequencySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('INTERVAL'), everyMinutes: z.number().int().min(1).max(10_080) }),
  z.object({ kind: z.literal('DAILY'), localTime: LocalTimeSchema }),
  z.object({
    kind: z.literal('WEEKLY'),
    localTime: LocalTimeSchema,
    /** 0 = domingo … 6 = sábado, en la zona horaria de la programación. */
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  }),
]);
export type ScheduleFrequency = z.infer<typeof ScheduleFrequencySchema>;

export const DEFAULT_TIME_ZONE = 'America/Argentina/Buenos_Aires';

export const CreateScheduleRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  jobType: JobTypeNameSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  frequency: ScheduleFrequencySchema,
  timeZone: z.string().min(1).max(64).default(DEFAULT_TIME_ZONE),
  enabled: z.boolean().default(true),
  priority: PrioritySchema.optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  timeoutSeconds: z.number().int().min(1).max(900).optional(),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

export const UpdateScheduleRequestSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  frequency: ScheduleFrequencySchema.optional(),
  timeZone: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  priority: PrioritySchema.optional(),
});
export type UpdateScheduleRequest = z.infer<typeof UpdateScheduleRequestSchema>;

export const ScheduleDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  jobType: z.string(),
  payload: z.record(z.string(), z.unknown()),
  frequency: ScheduleFrequencySchema,
  timeZone: z.string(),
  enabled: z.boolean(),
  priority: z.number().int(),
  maxAttempts: z.number().int(),
  timeoutSeconds: z.number().int(),
  nextRunAt: IsoDateTimeSchema.nullable(),
  /** Próxima ejecución expresada en la zona de la programación (calculada en el servidor). */
  nextRunLocal: z.string().nullable(),
  lastRunAt: IsoDateTimeSchema.nullable(),
  lastJobId: z.uuid().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ScheduleDto = z.infer<typeof ScheduleDtoSchema>;

/* ---------- Circuit breakers, reloj y tipos ---------- */

export const CircuitBreakerDtoSchema = z.object({
  key: z.string(),
  state: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']),
  consecutiveFailures: z.number().int(),
  openUntil: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type CircuitBreakerDto = z.infer<typeof CircuitBreakerDtoSchema>;

/** Hora oficial del servidor: el dashboard NO usa el reloj del navegador para decidir. */
export const ServerClockDtoSchema = z.object({
  utc: IsoDateTimeSchema,
  timeZone: z.string(),
  local: z.string(),
  offsetMinutes: z.number().int(),
  crons: z.array(z.object({ name: z.string(), expression: z.string() })),
});
export type ServerClockDto = z.infer<typeof ServerClockDtoSchema>;

export const JobTypeDtoSchema = z.object({
  type: z.string(),
  category: JobCategorySchema,
  description: z.string(),
  defaultPriority: z.number().int(),
  defaultMaxAttempts: z.number().int(),
  defaultTimeoutSeconds: z.number().int(),
});
export type JobTypeDto = z.infer<typeof JobTypeDtoSchema>;

export const TickResultDtoSchema = z.object({
  ran: z.boolean(),
  detail: z.record(z.string(), z.number()),
});
export type TickResultDto = z.infer<typeof TickResultDtoSchema>;

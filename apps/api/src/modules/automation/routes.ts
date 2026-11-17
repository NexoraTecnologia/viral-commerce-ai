import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { circuitBreakers } from '@vc/database';
import { ARGENTINA_TZ, CLOSED_BREAKER, formatInTimeZone, timeZoneOffsetMinutes } from '@vc/queue';
import {
  appError,
  CreateJobRequestSchema,
  CreateScheduleRequestSchema,
  JobStatusSchema,
  newId,
  UpdateScheduleRequestSchema,
  type CircuitBreakerDto,
  type JobTypeDto,
  type ServerClockDto,
} from '@vc/shared';
import { saveBreaker } from '../../automation/breaker-store';
import { defaultHandlers } from '../../automation/handlers';
import {
  cancelJob,
  createJob,
  getJobDetail,
  listJobs,
  retryJob,
  toJobDto,
} from '../../automation/job-manager';
import { CRON_TRIGGERS } from '../../automation/orchestrator';
import { runRecoveryTick } from '../../automation/recovery';
import { runSchedulerTick } from '../../automation/scheduler';
import { createSchedule, listSchedules, updateSchedule } from '../../automation/schedules';
import { systemClock, type AutomationDeps } from '../../automation/types';
import { secretsFromEnv, type AppBindings } from '../../env';
import { fail, idParam, readJson, respond } from '../../http';

const depsFor = (c: Context<AppBindings>): AutomationDeps => ({
  db: c.var.db,
  queue: c.env.JOBS_QUEUE,
  clock: systemClock,
  handlers: defaultHandlers,
  config: c.var.config,
  workerId: `http:${newId()}`,
  secrets: secretsFromEnv(c.env),
});

export const automationRoutes = new Hono<AppBindings>()
  /** Hora oficial del servidor (UTC) y su equivalente en Argentina. */
  .get('/clock', (c) => {
    const now = systemClock.now();
    const body: ServerClockDto = {
      utc: now.toISOString(),
      timeZone: ARGENTINA_TZ,
      local: formatInTimeZone(now, ARGENTINA_TZ),
      offsetMinutes: timeZoneOffsetMinutes(now, ARGENTINA_TZ),
      crons: CRON_TRIGGERS,
    };
    return c.json(body);
  })

  .get('/job-types', (c) => {
    const items: JobTypeDto[] = [...defaultHandlers.values()].map((h) => ({
      type: h.type,
      category: h.category,
      description: h.description,
      defaultPriority: h.defaultPriority,
      defaultMaxAttempts: h.defaultMaxAttempts,
      defaultTimeoutSeconds: h.defaultTimeoutSeconds,
    }));
    return c.json({ items });
  })

  .get('/jobs', async (c) => {
    const raw = c.req.query('status');
    const status = raw === undefined ? undefined : JobStatusSchema.safeParse(raw);
    if (status && !status.success) return fail(c, appError('VALIDATION_ERROR', 'Estado inválido'));
    return c.json({ items: await listJobs(c.var.db, c.var.tenantId, status?.data) });
  })

  .post('/jobs', async (c) => {
    const body = await readJson(c, CreateJobRequestSchema);
    if (!body.ok) return fail(c, body.error);
    const r = await createJob(depsFor(c), c.var.tenantId, body.value);
    if (!r.ok) return fail(c, r.error);
    return c.json(
      { job: toJobDto(r.value.job), created: r.value.created },
      r.value.created ? 201 : 200,
    );
  })

  .get('/jobs/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await getJobDetail(c.var.db, c.var.tenantId, id.value));
  })

  .post('/jobs/:id/cancel', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const r = await cancelJob(depsFor(c), c.var.tenantId, id.value, 'Cancelado desde el dashboard');
    return r.ok ? c.json(toJobDto(r.value)) : fail(c, r.error);
  })

  .post('/jobs/:id/retry', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const r = await retryJob(depsFor(c), c.var.tenantId, id.value);
    return r.ok ? c.json(toJobDto(r.value)) : fail(c, r.error);
  })

  .get('/schedules', async (c) => c.json({ items: await listSchedules(c.var.db, c.var.tenantId) }))

  .post('/schedules', async (c) => {
    const body = await readJson(c, CreateScheduleRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await createSchedule(depsFor(c), c.var.tenantId, body.value), 201);
  })

  .patch('/schedules/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, UpdateScheduleRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await updateSchedule(depsFor(c), c.var.tenantId, id.value, body.value));
  })

  .get('/circuit-breakers', async (c) => {
    const rows = await c.var.db
      .select()
      .from(circuitBreakers)
      .where(eq(circuitBreakers.tenantId, c.var.tenantId))
      .limit(200);
    const items: CircuitBreakerDto[] = rows.map((b) => ({
      key: b.key,
      state: b.state,
      consecutiveFailures: b.consecutiveFailures,
      openUntil: b.openUntil ? b.openUntil.toISOString() : null,
      updatedAt: b.updatedAt.toISOString(),
    }));
    return c.json({ items });
  })

  .post('/circuit-breakers/:key/reset', async (c) => {
    const key = c.req.param('key');
    const exists = await c.var.db
      .select({ key: circuitBreakers.key })
      .from(circuitBreakers)
      .where(and(eq(circuitBreakers.tenantId, c.var.tenantId), eq(circuitBreakers.key, key)))
      .get();
    if (!exists) return fail(c, appError('NOT_FOUND', 'Circuit breaker no encontrado'));
    await saveBreaker(c.var.db, c.var.tenantId, key, CLOSED_BREAKER, systemClock.now());
    return c.json({ key, state: 'CLOSED' });
  })

  /**
   * Solo desarrollo (el router entero exige APP_ENV=development hasta tener
   * autenticación): dispara un tick sin esperar al Cron Trigger. Afecta a todos los tenants.
   */
  .post('/tick/:which', async (c) => {
    const which = c.req.param('which');
    if (which !== 'scheduler' && which !== 'recovery') {
      return fail(c, appError('NOT_FOUND', 'Tick desconocido'));
    }
    const deps = depsFor(c);
    return c.json(
      which === 'scheduler' ? await runSchedulerTick(deps) : await runRecoveryTick(deps),
    );
  });

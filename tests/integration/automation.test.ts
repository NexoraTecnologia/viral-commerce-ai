import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  auditEvents,
  createDb,
  jobAttempts,
  jobs,
  jobSchedules,
  tenants,
  type D1Binding,
  type Database,
} from '@vc/database';
import { PermanentJobError, RecoverableJobError, type QueueMessage } from '@vc/queue';
import { parseApiConfig } from '@vc/shared';
import { acquireLock } from '../../apps/api/src/automation/locks';
import { executeJob } from '../../apps/api/src/automation/executor';
import { defaultHandlers } from '../../apps/api/src/automation/handlers';
import {
  cancelJob,
  createJob,
  getJobDetail,
  retryJob,
} from '../../apps/api/src/automation/job-manager';
import { handleQueueBatch, type ConsumedMessage } from '../../apps/api/src/automation/orchestrator';
import { runRecoveryTick } from '../../apps/api/src/automation/recovery';
import { runSchedulerTick } from '../../apps/api/src/automation/scheduler';
import { createSchedule } from '../../apps/api/src/automation/schedules';
import {
  defineHandler,
  registryOf,
  type AutomationDeps,
  type JobHandler,
} from '../../apps/api/src/automation/types';
import { createApp } from '../../apps/api/src/app';
import type { Env } from '../../apps/api/src/env';
import { createTestD1 } from '../support/node-d1';

/* ---------------------------------------------------------------------------
 * Harness: SQLite real con migraciones, cola falsa que registra envíos y reloj
 * controlado (UTC). Nada sale a la red.
 * ------------------------------------------------------------------------- */

const TENANT = '00000000-0000-4000-8000-000000000001';
const START = new Date('2026-11-16T11:00:00.000Z'); // 08:00 en Argentina

interface Sent {
  body: QueueMessage;
  delaySeconds?: number;
}

const calls: Record<string, number> = {};
const count = (type: string) => {
  calls[type] = (calls[type] ?? 0) + 1;
  return calls[type];
};

/** Controla manualmente cuándo termina un handler (para simular trabajos lentos). */
let releaseSlow: (() => void) | null = null;

const testHandler = (
  type: string,
  run: (attempt: number) => Promise<unknown>,
  extra: Partial<Pick<JobHandler, 'category' | 'defaultPriority' | 'defaultMaxAttempts'>> = {},
) =>
  defineHandler({
    type,
    category: extra.category ?? 'SYSTEM',
    description: `Handler de prueba ${type}`,
    defaultPriority: extra.defaultPriority ?? 50,
    defaultMaxAttempts: extra.defaultMaxAttempts ?? 3,
    defaultTimeoutSeconds: 5,
    payloadSchema: z.object({ n: z.number().optional() }),
    run: () => run(count(type)),
  });

const HANDLERS = registryOf([
  testHandler('test.ok', () => Promise.resolve({ ok: true })),
  testHandler('test.flaky', (n) =>
    n <= 2
      ? Promise.reject(new RecoverableJobError(`falla transitoria ${n}`))
      : Promise.resolve({ n }),
  ),
  testHandler('test.broken', () => Promise.reject(new PermanentJobError('datos inválidos'))),
  testHandler('test.always_fail', () => Promise.reject(new Error('dependencia caída'))),
  testHandler('test.hang', () => new Promise(() => undefined)),
  testHandler(
    'test.slow',
    () =>
      new Promise((resolve) => {
        releaseSlow = () => {
          resolve({ late: true });
        };
      }),
  ),
  testHandler('test.commercial', () => Promise.resolve({ ok: true }), {
    category: 'COMMERCIAL',
    defaultPriority: 10,
  }),
  testHandler('test.low', () => Promise.resolve({ ok: true }), { defaultPriority: 80 }),
]);

let db: Database;
let sent: Sent[];
let now: Date;
let sleepResolves: boolean;
let deps: AutomationDeps;

const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

const makeDeps = (overrides: Partial<AutomationDeps> = {}): AutomationDeps => ({
  db,
  queue: {
    sendBatch: (messages) => {
      sent.push(...messages);
      return Promise.resolve();
    },
  },
  clock: {
    now: () => new Date(now),
    // Si sleepResolves = false, los timeouts nunca disparan (trabajos "a tiempo").
    sleep: () => (sleepResolves ? Promise.resolve() : new Promise(() => undefined)),
  },
  handlers: HANDLERS,
  config: parseApiConfig({}),
  workerId: 'test-worker',
  ...overrides,
});

const getJob = (id: string) => db.select().from(jobs).where(eq(jobs.id, id)).get();
const auditActions = async (entityId: string) =>
  (await db.select().from(auditEvents).where(eq(auditEvents.entityId, entityId))).map(
    (a) => a.action,
  );

const create = async (type: string, extra: Record<string, unknown> = {}) => {
  const r = await createJob(deps, TENANT, { type, payload: {}, ...extra });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

beforeEach(async () => {
  db = createDb(createTestD1() as unknown as D1Binding);
  sent = [];
  now = new Date(START);
  sleepResolves = false;
  releaseSlow = null;
  for (const k of Object.keys(calls)) calls[k] = 0;
  deps = makeDeps();
  await db.insert(tenants).values({ id: TENANT, name: 'Tenant de prueba', slug: 'prueba' });
});

/* ------------------------------- Escenarios ------------------------------ */

describe('trabajo exitoso', () => {
  it('PENDING → encolado → COMPLETED con resultado, intento y auditoría', async () => {
    const { job, created } = await create('test.ok');
    expect(created).toBe(true);
    expect(job.status).toBe('PENDING');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ type: 'job.execute', payload: { jobId: job.id } });

    const r = await executeJob(deps, job.id);
    expect(r.outcome).toBe('COMPLETED');

    const detail = await getJobDetail(db, TENANT, job.id);
    expect(detail.ok && detail.value.job).toMatchObject({
      status: 'COMPLETED',
      attempts: 1,
      result: { ok: true },
      lastError: null,
    });
    expect(detail.ok && detail.value.attempts.map((a) => a.status)).toEqual(['SUCCEEDED']);
    expect(await auditActions(job.id)).toEqual(['job.created', 'job.completed']);
  });
});

describe('trabajo duplicado', () => {
  it('la misma clave de idempotencia devuelve el trabajo existente', async () => {
    const a = await create('test.ok', { idempotencyKey: 'pedido-123' });
    const b = await create('test.ok', { idempotencyKey: 'pedido-123' });
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it('mensajes repetidos o concurrentes ejecutan el trabajo una sola vez', async () => {
    const { job } = await create('test.ok');
    const [r1, r2] = await Promise.all([executeJob(deps, job.id), executeJob(deps, job.id)]);
    expect([r1.outcome, r2.outcome].sort()).toEqual(['COMPLETED', 'SKIPPED']);
    expect((await executeJob(deps, job.id)).outcome).toBe('SKIPPED');
    expect(calls['test.ok']).toBe(1);
  });
});

describe('error recuperable', () => {
  it('pasa a RETRYING con backoff y se re-encola con demora', async () => {
    const { job } = await create('test.flaky');
    sent = [];
    const r = await executeJob(deps, job.id);
    expect(r.outcome).toBe('RETRYING');

    const row = await getJob(job.id);
    expect(row).toMatchObject({ status: 'RETRYING', attempts: 1, lastErrorKind: 'RECOVERABLE' });
    expect(row?.runAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 30_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.delaySeconds).toBeGreaterThanOrEqual(30);

    // Antes de que venza el backoff, un mensaje adelantado no lo ejecuta.
    expect((await executeJob(deps, job.id)).outcome).toBe('SKIPPED');
  });
});

describe('error permanente', () => {
  it('pasa a FAILED sin reintentos ni nuevos envíos', async () => {
    const { job } = await create('test.broken');
    sent = [];
    expect((await executeJob(deps, job.id)).outcome).toBe('FAILED');
    expect(await getJob(job.id)).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastErrorKind: 'PERMANENT',
      lastError: 'datos inválidos',
    });
    expect(sent).toHaveLength(0);
  });
});

describe('reintento', () => {
  it('reintenta hasta tener éxito y registra cada intento', async () => {
    const { job } = await create('test.flaky');
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      outcomes.push((await executeJob(deps, job.id)).outcome);
      advance(2 * 3_600_000); // supera cualquier backoff
    }
    expect(outcomes).toEqual(['RETRYING', 'RETRYING', 'COMPLETED']);
    const detail = await getJobDetail(db, TENANT, job.id);
    expect(detail.ok && detail.value.attempts.map((a) => a.status)).toEqual([
      'SUCCEEDED',
      'FAILED',
      'FAILED',
    ]);
  });

  it('respeta el límite de intentos → DEAD_LETTER, y permite reintento manual', async () => {
    const { job } = await create('test.always_fail', { maxAttempts: 3 });
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      outcomes.push((await executeJob(deps, job.id)).outcome);
      advance(2 * 3_600_000);
    }
    expect(outcomes).toEqual(['RETRYING', 'RETRYING', 'DEAD_LETTER']);
    expect(await getJob(job.id)).toMatchObject({ status: 'DEAD_LETTER', attempts: 3 });

    const manual = await retryJob(deps, TENANT, job.id);
    expect(manual.ok && manual.value).toMatchObject({ status: 'RETRYING', attempts: 0 });
  });

  it('timeout: un trabajo colgado se corta y se reintenta', async () => {
    sleepResolves = true;
    const { job } = await create('test.hang');
    expect((await executeJob(deps, job.id)).outcome).toBe('RETRYING');
    expect(await getJob(job.id)).toMatchObject({ lastErrorKind: 'TIMEOUT' });
  });
});

describe('recuperación', () => {
  it('un trabajo interrumpido (lease vencido) vuelve a RETRYING y el resultado tardío se descarta', async () => {
    const { job } = await create('test.slow');
    const running = executeJob(deps, job.id); // queda "colgado" como si el Worker muriera
    for (let i = 0; i < 50 && (await getJob(job.id))?.status !== 'RUNNING'; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect((await getJob(job.id))?.status).toBe('RUNNING');

    advance(10 * 60_000); // supera timeout + gracia
    const tick = await runRecoveryTick(deps);
    expect(tick).toMatchObject({ ran: true, detail: { recovered: 1 } });
    expect(await getJob(job.id)).toMatchObject({ status: 'RETRYING', lockedBy: null });
    const attempts = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id));
    expect(attempts.map((a) => a.status)).toEqual(['INTERRUPTED']);

    // El ejecutor original "revive" y termina: su resultado no pisa el estado.
    releaseSlow?.();
    expect((await running).outcome).toBe('SKIPPED');
    expect((await getJob(job.id))?.status).toBe('RETRYING');
    expect(await auditActions(job.id)).toContain('job.stale_result_discarded');
  });

  it('sin intentos restantes, el interrumpido pasa a DEAD_LETTER', async () => {
    const { job } = await create('test.slow', { maxAttempts: 1 });
    void executeJob(deps, job.id);
    for (let i = 0; i < 50 && (await getJob(job.id))?.status !== 'RUNNING'; i++) {
      await new Promise((r) => setImmediate(r));
    }
    advance(10 * 60_000);
    await runRecoveryTick(deps);
    expect((await getJob(job.id))?.status).toBe('DEAD_LETTER');
  });

  it('re-despacha desde D1 mensajes perdidos (no depende de la retención de la cola)', async () => {
    const { job } = await create('test.ok');
    sent = [];
    advance(20 * 60_000);
    const tick = await runRecoveryTick(deps);
    expect(tick.detail['redispatched']).toBe(1);
    expect(sent.map((s) => s.body.type === 'job.execute' && s.body.payload.jobId)).toEqual([
      job.id,
    ]);
  });
});

describe('tarea programada', () => {
  it('DAILY 09:00 hora Argentina se ejecuta a las 12:00 UTC, una sola vez', async () => {
    const r = await createSchedule(deps, TENANT, {
      name: 'Escaneo diario',
      jobType: 'test.ok',
      payload: {},
      frequency: { kind: 'DAILY', localTime: '09:00' },
      timeZone: 'America/Argentina/Buenos_Aires',
      enabled: true,
    });
    expect(r.ok && r.value).toMatchObject({
      nextRunAt: '2026-11-16T12:00:00.000Z',
      nextRunLocal: '2026-11-16T09:00:00-03:00',
    });

    advance(30 * 60_000); // 08:30 ART
    expect((await runSchedulerTick(deps)).detail).toMatchObject({ materialized: 0 });

    advance(30 * 60_000 + 30_000); // 09:00:30 ART
    sent = [];
    expect((await runSchedulerTick(deps)).detail).toMatchObject({ materialized: 1, dispatched: 1 });
    expect((await runSchedulerTick(deps)).detail).toMatchObject({ materialized: 0, dispatched: 0 });
    expect(await db.select().from(jobs)).toHaveLength(1);
    expect(sent).toHaveLength(1);

    const schedule = await db.select().from(jobSchedules).get();
    expect(schedule?.nextRunAt?.toISOString()).toBe('2026-11-17T12:00:00.000Z');
  });

  it('con un reloj que avanza, el trabajo materializado se despacha en el mismo tick', async () => {
    // Regresión: createJob leía el reloj otra vez y run_at quedaba ms después del "now" del tick.
    deps = makeDeps({
      clock: {
        now: () => {
          advance(1);
          return new Date(now);
        },
        sleep: () => new Promise(() => undefined),
      },
    });
    await createSchedule(deps, TENANT, {
      name: 'Cada minuto',
      jobType: 'test.ok',
      payload: {},
      frequency: { kind: 'INTERVAL', everyMinutes: 1 },
      timeZone: 'America/Argentina/Buenos_Aires',
      enabled: true,
    });
    advance(61_000);
    sent = [];
    expect((await runSchedulerTick(deps)).detail).toMatchObject({ materialized: 1, dispatched: 1 });
    expect(sent).toHaveLength(1);
  });

  it('un trabajo con runAt futuro queda SCHEDULED y se despacha al vencer', async () => {
    const runAt = new Date(now.getTime() + 60 * 60_000).toISOString();
    const { job } = await create('test.ok', { runAt });
    expect(job.status).toBe('SCHEDULED');
    expect(sent).toHaveLength(0);
    expect((await runSchedulerTick(deps)).detail['dispatched']).toBe(0);
    advance(61 * 60_000);
    expect((await runSchedulerTick(deps)).detail['dispatched']).toBe(1);
    expect((await executeJob(deps, job.id)).outcome).toBe('COMPLETED');
  });

  it('el Scheduler no corre si otro tiene el lock', async () => {
    await acquireLock(db, 'scheduler', 'otro-worker', now, 60_000);
    expect(await runSchedulerTick(deps)).toEqual({ ran: false, detail: {} });
  });
});

describe('tarea vencida', () => {
  it('un trabajo vencido se cancela sin ejecutarse', async () => {
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const { job } = await create('test.ok', { expiresAt });
    advance(6 * 60_000);
    expect((await runSchedulerTick(deps)).detail['expired']).toBe(1);
    expect(await getJob(job.id)).toMatchObject({ status: 'CANCELLED', lastError: 'EXPIRED' });
    expect((await executeJob(deps, job.id)).outcome).toBe('SKIPPED');
    expect(calls['test.ok'] ?? 0).toBe(0);
  });

  it('el ejecutor también descarta un trabajo vencido que llega por la cola', async () => {
    const { job } = await create('test.ok', {
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    advance(2 * 60_000);
    expect((await executeJob(deps, job.id)).outcome).toBe('EXPIRED');
    expect(calls['test.ok'] ?? 0).toBe(0);
  });

  it('una programación muy atrasada corre una sola vez (sin ráfaga) y registra misfire', async () => {
    await createSchedule(deps, TENANT, {
      name: 'Cada 15 min',
      jobType: 'test.ok',
      payload: {},
      frequency: { kind: 'INTERVAL', everyMinutes: 15 },
      timeZone: 'America/Argentina/Buenos_Aires',
      enabled: true,
    });
    advance(3 * 3_600_000); // 3 h caído = 12 ejecuciones perdidas
    expect((await runSchedulerTick(deps)).detail).toMatchObject({ materialized: 1, misfires: 1 });
    expect(await db.select().from(jobs)).toHaveLength(1);
    const schedule = await db.select().from(jobSchedules).get();
    expect(schedule?.nextRunAt?.getTime()).toBe(now.getTime() + 15 * 60_000);
  });
});

/* ------------------------- Prioridad, breaker, DLQ ------------------------ */

describe('prioridad de eventos comerciales', () => {
  it('el Scheduler despacha primero lo comercial y el consumidor lo ejecuta primero', async () => {
    const low = await create('test.low', { runAt: new Date(now.getTime() + 60_000).toISOString() });
    const com = await create('test.commercial', {
      runAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    advance(2 * 60_000);
    sent = [];
    await runSchedulerTick(deps);
    expect(sent.map((s) => s.body.type === 'job.execute' && s.body.payload.jobId)).toEqual([
      com.job.id,
      low.job.id,
    ]);

    // Lote recibido en orden inverso: el consumidor reordena por prioridad.
    const order: string[] = [];
    const messages: ConsumedMessage[] = [...sent].reverse().map((s, i) => ({
      id: `m${i}`,
      body: s.body,
      ack: () => {
        order.push(s.body.type === 'job.execute' ? s.body.payload.jobId : '');
      },
      retry: () => undefined,
    }));
    await handleQueueBatch(deps, { queue: 'viralcommerce-jobs', messages });
    expect(order).toEqual([com.job.id, low.job.id]);
  });
});

describe('circuit breaker', () => {
  it('tras N fallas seguidas difiere los trabajos de ese tipo', async () => {
    deps = makeDeps({ breaker: { failureThreshold: 2, cooldownMs: 10 * 60_000 } });
    const a = await create('test.always_fail', { maxAttempts: 10 });
    await executeJob(deps, a.job.id);
    advance(2 * 3_600_000);
    await executeJob(deps, a.job.id);

    const b = await create('test.always_fail', { maxAttempts: 10 });
    expect((await executeJob(deps, b.job.id)).outcome).toBe('DEFERRED');
    expect(await getJob(b.job.id)).toMatchObject({
      status: 'RETRYING',
      attempts: 0,
      lastError: 'CIRCUIT_OPEN',
    });
  });
});

describe('dead letter de la cola', () => {
  it('un mensaje en la DLQ marca el trabajo como DEAD_LETTER', async () => {
    const { job } = await create('test.ok');
    const acked: string[] = [];
    await handleQueueBatch(deps, {
      queue: 'viralcommerce-jobs-dlq',
      messages: [
        {
          id: 'm1',
          body: sent[0]?.body,
          ack: () => acked.push('m1'),
          retry: () => undefined,
        },
      ],
    });
    expect(acked).toEqual(['m1']);
    expect((await getJob(job.id))?.status).toBe('DEAD_LETTER');
  });

  it('si D1 falla, el mensaje se reintenta en la cola (no se pierde)', async () => {
    const broken = makeDeps({
      db: new Proxy(db, {
        get: () => () => {
          throw new Error('D1 no disponible');
        },
      }),
    });
    const retried: string[] = [];
    const { job } = await create('test.ok');
    await handleQueueBatch(broken, {
      queue: 'viralcommerce-jobs',
      messages: [
        {
          id: 'm1',
          body: sent[0]?.body,
          ack: () => undefined,
          retry: () => retried.push('m1'),
        },
      ],
    });
    expect(retried).toEqual(['m1']);
    expect((await getJob(job.id))?.status).toBe('PENDING');
  });
});

describe('job manager', () => {
  it('rechaza tipos y payloads desconocidos', async () => {
    expect((await createJob(deps, TENANT, { type: 'nope.nope', payload: {} })).ok).toBe(false);
    expect((await createJob(deps, TENANT, { type: 'test.ok', payload: { n: 'x' } })).ok).toBe(
      false,
    );
  });

  it('cancela solo trabajos no iniciados', async () => {
    const { job } = await create('test.ok');
    expect((await cancelJob(deps, TENANT, job.id, 'manual')).ok).toBe(true);
    expect((await cancelJob(deps, TENANT, job.id, 'manual')).ok).toBe(false);
    const done = await create('test.ok');
    await executeJob(deps, done.job.id);
    expect((await cancelJob(deps, TENANT, done.job.id, 'manual')).ok).toBe(false);
  });

  it('los handlers reales están registrados y son internos', () => {
    expect([...defaultHandlers.keys()].sort()).toEqual([
      'channels.auto_publish',
      'channels.connection_check',
      'channels.webhook_process',
      'discovery.rescore',
      'discovery.source_sync',
      'inventory.stale_scan',
      'profit.recalculate_product',
      'supplier.evidence_expiry_scan',
      'system.ping',
    ]);
    expect(defaultHandlers.get('profit.recalculate_product')?.category).toBe('COMMERCIAL');
  });
});

/* ------------------------------ API HTTP ---------------------------------- */

describe('API de automatización', () => {
  it('crea trabajos idempotentes, programa en hora Argentina y expone el reloj del servidor', async () => {
    const queueSent: unknown[] = [];
    const d1 = createTestD1();
    const env = {
      DB: d1,
      JOBS_QUEUE: {
        sendBatch: (m: unknown[]) => {
          queueSent.push(...m);
          return Promise.resolve();
        },
      },
      APP_ENV: 'development',
      ALLOWED_ORIGINS: 'http://localhost:5173',
      COMMERCIAL_ACTIONS_ENABLED: 'false',
    } as unknown as Env;
    const app = createApp();
    const call = async (method: string, path: string, body?: unknown, tenant?: string) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (tenant) headers['x-tenant-id'] = tenant;
      const res = await app.request(
        path,
        { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
        env,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: Record<string, any> = await res.json();
      return { status: res.status, json };
    };

    const tenant = (await call('POST', '/v1/tenants', { name: 'API', slug: 'api' })).json[
      'id'
    ] as string;

    const job = { type: 'system.ping', payload: {}, idempotencyKey: 'ping-1' };
    const first = await call('POST', '/v1/automation/jobs', job, tenant);
    const second = await call('POST', '/v1/automation/jobs', job, tenant);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.json['created']).toBe(false);
    expect(second.json['job'].id).toBe(first.json['job'].id);
    expect(queueSent).toHaveLength(1);

    const schedule = await call(
      'POST',
      '/v1/automation/schedules',
      {
        name: 'Ping diario',
        jobType: 'system.ping',
        frequency: { kind: 'DAILY', localTime: '06:00' },
      },
      tenant,
    );
    expect(schedule.status).toBe(201);
    expect(schedule.json['timeZone']).toBe('America/Argentina/Buenos_Aires');
    expect(schedule.json['nextRunLocal']).toMatch(/T06:00:00-03:00$/);

    const clock = await call('GET', '/v1/automation/clock', undefined, tenant);
    expect(clock.json['offsetMinutes']).toBe(-180);
    expect(clock.json['crons']).toHaveLength(2);

    const badTz = await call(
      'POST',
      '/v1/automation/schedules',
      {
        name: 'Mal',
        jobType: 'system.ping',
        timeZone: 'Marte/Olympus',
        frequency: { kind: 'DAILY', localTime: '06:00' },
      },
      tenant,
    );
    expect(badTz.status).toBe(400);
  });
});

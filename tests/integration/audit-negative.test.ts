import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, jobs, type Database } from '@vc/database';
import { parseApiConfig } from '@vc/shared';
import { createApp } from '../../apps/api/src/app';
import { defaultHandlers } from '../../apps/api/src/automation/handlers';
import { createJob } from '../../apps/api/src/automation/job-manager';
import { handleQueueBatch, type ConsumedMessage } from '../../apps/api/src/automation/orchestrator';
import { runSchedulerTick } from '../../apps/api/src/automation/scheduler';
import type { AutomationDeps } from '../../apps/api/src/automation/types';
import { secretsFromEnv, type Env } from '../../apps/api/src/env';
import { processWebhookEvent } from '../../apps/api/src/modules/channels/webhooks';
import { createTestD1 } from '../support/node-d1';

/**
 * AUDITORÍA — pruebas negativas obligatorias (A–J) y medición de consultas D1.
 * HTTP → reglas → SQLite real. Sin red: `fetch` es un doble. Valores de PRUEBA.
 */
const app = createApp();
let env: Env;
let d1: ReturnType<typeof createTestD1>;
let queries = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const call = async (
  method: string,
  path: string,
  body?: unknown,
  tenant?: string,
  e: Env = env,
) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await app.request(
    path,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    e,
  );
  const text = await res.text();
  let json: Json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
};

const TEST_SECRETS = {
  TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 7))),
  PUBLIC_API_URL: 'https://api.test.example',
  ML_APP_ID: 'test-app-id',
  ML_CLIENT_SECRET: 'test-client-secret',
};

const fetchCalls: { url: string; method: string }[] = [];
const network = (responder: (url: string) => unknown) => {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
    fetchCalls.push({ url, method: init?.method ?? 'GET' });
    const r = responder(url);
    return Promise.resolve(
      r instanceof Response
        ? r
        : new Response(JSON.stringify(r), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    );
  });
};

const nowIso = () => new Date().toISOString();
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const tenantOf = async (slug: string) =>
  (await call('POST', '/v1/tenants', { name: slug, slug })).json.id as string;

const SUPPLIER = {
  legalName: 'Proveedor Auditoría SRL',
  countryCode: 'AR',
  contacts: [],
  paymentMethods: ['BANK_TRANSFER'],
  directDispatch: true,
  dispatchLeadTimeDaysMax: 1,
  deliveryTimeDaysMin: 2,
  deliveryTimeDaysMax: 5,
  acceptsReturns: true,
  returnWindowDays: 30,
  trackingAvailable: true,
  requiresPrepayment: true,
  paymentDueDays: 0,
};

/** Candidato real: proveedor verificado, stock confirmado, margen OK, contenido generado. */
const candidate = async (t: string) => {
  const supplier = (await call('POST', '/v1/suppliers', SUPPLIER, t)).json;
  const product = (
    await call(
      'POST',
      '/v1/products',
      { title: 'Organizador', salePriceCents: 100_000, currency: 'ARS' },
      t,
    )
  ).json;
  await call(
    'POST',
    `/v1/products/${product.id}/costs`,
    { kind: 'SHIPPING', name: 'Envío', fixedCents: 5_000 },
    t,
  );
  const offer = (
    await call(
      'POST',
      '/v1/supplier-products',
      {
        supplierId: supplier.id,
        productId: product.id,
        supplierSku: 'AUD-1',
        title: 'Organizador',
        wholesalePriceCents: 40_000,
        currency: 'ARS',
        priceSource: 'SUPPLIER_REPORT',
      },
      t,
    )
  ).json;
  await call(
    'POST',
    `/v1/supplier-products/${offer.id}/inventory`,
    { stockStatus: 'IN_STOCK', quantity: 20, source: 'SUPPLIER_REPORT' },
    t,
  );
  await call(
    'POST',
    `/v1/suppliers/${supplier.id}/status`,
    { to: 'UNDER_REVIEW', reason: 'revisión' },
    t,
  );
  for (const category of ['IDENTITY', 'COMMERCIAL_TERMS', 'DISPATCH_CAPABILITY']) {
    const ev = await call(
      'POST',
      `/v1/suppliers/${supplier.id}/evidence`,
      { category, description: `Doc ${category}`, reference: `REF-${category}` },
      t,
    );
    await call(
      'POST',
      `/v1/suppliers/${supplier.id}/evidence/${ev.json.id}/review`,
      { decision: 'ACCEPTED' },
      t,
    );
  }
  await call(
    'POST',
    `/v1/suppliers/${supplier.id}/status`,
    { to: 'VERIFIED', reason: 'Evidencia completa' },
    t,
  );
  const source = (
    await call('POST', '/v1/discovery/sources', { name: 'Catálogo', kind: 'SUPPLIER_CATALOG' }, t)
  ).json;
  await call('POST', `/v1/discovery/sources/${source.id}/sync`, undefined, t);
  const [dp] = (await call('GET', '/v1/discovery/products', undefined, t)).json.items;
  await call(
    'POST',
    `/v1/discovery/products/${dp.id}/images`,
    {
      url: 'https://cdn.example.com/a.jpg',
      authorization: 'SUPPLIER_WRITTEN',
      authorizationRef: 'mail-proveedor',
    },
    t,
  );
  expect((await call('POST', `/v1/discovery/products/${dp.id}/promote`, undefined, t)).status).toBe(
    200,
  );
  await call('POST', `/v1/discovery/products/${dp.id}/content`, undefined, t);
  const conn = (
    await call(
      'POST',
      '/v1/channels/connections',
      { channel: 'OWN_STORE', mode: 'MOCK', displayName: 'Tienda simulada' },
      t,
    )
  ).json;
  const listing = (
    await call(
      'POST',
      '/v1/channels/listings',
      { connectionId: conn.id, discoveredProductId: dp.id },
      t,
    )
  ).json;
  expect(listing.status).toBe('READY');
  return {
    supplierId: supplier.id as string,
    productId: product.id as string,
    offerId: offer.id as string,
    listingId: listing.id as string,
  };
};

const failedChecks = (r: { json: Json }) =>
  (r.json.error?.details?.failed ?? []).map((c: Json) => c.check);

beforeEach(() => {
  d1 = createTestD1();
  const original = d1.prepare.bind(d1);
  d1.prepare = (sql: string) => {
    queries++;
    return original(sql);
  };
  env = {
    DB: d1,
    JOBS_QUEUE: { sendBatch: () => Promise.resolve() },
    APP_ENV: 'development',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    COMMERCIAL_ACTIONS_ENABLED: 'false',
  } as unknown as Env;
  fetchCalls.length = 0;
  network(() => new Response('sin red en tests', { status: 599 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('A. Proveedor no verificado → bloquea publicación', () => {
  it('si el proveedor se suspende después de aprobar el candidato, la publicación (aun simulada) se bloquea', async () => {
    const t = await tenantOf('aud-a');
    const { supplierId, listingId } = await candidate(t);
    await call(
      'POST',
      `/v1/suppliers/${supplierId}/status`,
      { to: 'SUSPENDED', reason: 'Incumplimiento detectado' },
      t,
    );
    const r = await call('POST', `/v1/channels/listings/${listingId}/publish`, undefined, t);
    expect(r.status).toBe(409);
    expect(failedChecks(r)).toEqual(expect.arrayContaining(['SUPPLIER_VERIFIED', 'RISK_GUARDIAN']));
  });
});

describe('B. Stock desconocido → bloquea publicación y abastecimiento', () => {
  it('stock UNKNOWN bloquea publicar y el pedido no se ordena al proveedor', async () => {
    const t = await tenantOf('aud-b');
    const { offerId, listingId, productId } = await candidate(t);
    await call(
      'POST',
      `/v1/supplier-products/${offerId}/inventory`,
      { stockStatus: 'UNKNOWN', source: 'SUPPLIER_REPORT' },
      t,
    );
    const pub = await call('POST', `/v1/channels/listings/${listingId}/publish`, undefined, t);
    expect(pub.status).toBe(409);
    expect(failedChecks(pub)).toContain('STOCK_VERIFIABLE');

    await call(
      'POST',
      '/v1/finance/funds',
      {
        availableCents: 500_000,
        currency: 'ARS',
        asOf: ago(1),
        source: 'MANUAL',
        sourceRef: 'Extracto de prueba',
      },
      t,
    );
    const o = (
      await call(
        'POST',
        '/v1/orders',
        {
          buyerRef: 'comprador-b',
          currency: 'ARS',
          items: [{ productId, quantity: 1, unitPriceCents: 100_000 }],
        },
        t,
      )
    ).json;
    const paid = await call(
      'POST',
      `/v1/orders/${o.order.id}/payments`,
      {
        provider: 'Mercado Pago',
        externalPaymentId: 'MP-B',
        status: 'APPROVED',
        amountCents: 100_000,
        currency: 'ARS',
        evidenceSource: 'PAYMENT_PROVIDER_REPORT',
        evidenceRef: 'Reporte B',
        observedAt: nowIso(),
      },
      t,
    );
    expect(paid.json.order.state).toBe('BLOCKED_NO_STOCK');
    expect(paid.json.supplierOrders).toEqual([]);
  });

  it('stock "disponible" sin cantidad informada también bloquea la publicación (corrección de auditoría)', async () => {
    const t = await tenantOf('aud-b2');
    const { offerId, listingId } = await candidate(t);
    await call(
      'POST',
      `/v1/supplier-products/${offerId}/inventory`,
      { stockStatus: 'IN_STOCK', source: 'SUPPLIER_REPORT' },
      t,
    );
    const pub = await call('POST', `/v1/channels/listings/${listingId}/publish`, undefined, t);
    expect(pub.status).toBe(409);
    expect(failedChecks(pub)).toContain('STOCK_VERIFIABLE');
  });
});

describe('C. Margen inferior al mínimo → bloquea publicación', () => {
  it('bajar el precio por debajo del margen mínimo bloquea', async () => {
    const t = await tenantOf('aud-c');
    const { productId, listingId } = await candidate(t);
    await call('PATCH', `/v1/products/${productId}`, { salePriceCents: 50_000 }, t);
    const r = await call('POST', `/v1/channels/listings/${listingId}/publish`, undefined, t);
    expect(r.status).toBe(409);
    expect(failedChecks(r)).toContain('MIN_MARGIN');
  });
});

describe('D. Proveedor exige adelanto sin fondos → bloquea pedido', () => {
  it('sin saldo suficiente el pedido queda BLOCKED_CASHFLOW y no se puede solicitar despacho', async () => {
    const t = await tenantOf('aud-d');
    const { productId } = await candidate(t);
    await call(
      'POST',
      '/v1/finance/funds',
      {
        availableCents: 10_000,
        currency: 'ARS',
        asOf: ago(1),
        source: 'MANUAL',
        sourceRef: 'Extracto con saldo bajo',
      },
      t,
    );
    const o = (
      await call(
        'POST',
        '/v1/orders',
        {
          buyerRef: 'comprador-d',
          currency: 'ARS',
          items: [{ productId, quantity: 1, unitPriceCents: 100_000 }],
        },
        t,
      )
    ).json;
    const r = await call(
      'POST',
      `/v1/orders/${o.order.id}/payments`,
      {
        provider: 'Mercado Pago',
        externalPaymentId: 'MP-D',
        status: 'APPROVED',
        amountCents: 100_000,
        currency: 'ARS',
        evidenceSource: 'PAYMENT_PROVIDER_REPORT',
        evidenceRef: 'Reporte D',
        observedAt: nowIso(),
      },
      t,
    );
    expect(r.json.order.state).toBe('BLOCKED_CASHFLOW');
    expect(r.json.financialCheck.issues).toContain('PREPAYMENT_WITHOUT_FUNDS');
    expect(
      (await call('POST', `/v1/orders/${o.order.id}/dispatch-request`, { requestRef: 'OC-D' }, t))
        .status,
    ).toBe(409);
    // Ni con decisión manual se saltea la validación financiera.
    await call(
      'POST',
      `/v1/orders/${o.order.id}/resolve`,
      { to: 'MANUAL_REVIEW', reason: 'Revisar fondos' },
      t,
    );
    expect(
      (
        await call(
          'POST',
          `/v1/orders/${o.order.id}/resolve`,
          { to: 'FINANCIAL_APPROVED', reason: 'Forzar' },
          t,
        )
      ).status,
    ).toBe(409);
  });
});

describe('E. Webhook duplicado → no duplica el pedido', () => {
  it('reintentos del mismo webhook: un evento, un trabajo, un pedido del canal y un único pedido interno', async () => {
    env = { ...env, ...TEST_SECRETS };
    const t = await tenantOf('aud-e');
    const { productId } = await candidate(t);
    const conn = (
      await call(
        'POST',
        '/v1/channels/connections',
        { channel: 'MERCADO_LIBRE', mode: 'LIVE', displayName: 'ML' },
        t,
      )
    ).json;
    const start = await call(
      'POST',
      `/v1/channels/connections/${conn.id}/oauth/start`,
      undefined,
      t,
    );
    const state = new URL(start.json.authorizationUrl).searchParams.get('state') ?? '';
    network((u) =>
      u.endsWith('/oauth/token')
        ? {
            access_token: 'a',
            token_type: 'bearer',
            expires_in: 21600,
            scope: 'read write',
            user_id: 777,
            refresh_token: 'r',
          }
        : u.includes('/orders/555')
          ? {
              id: 555,
              status: 'paid',
              total_amount: 1000,
              currency_id: 'ARS',
              date_created: nowIso(),
            }
          : { id: 777, nickname: 'S' },
    );
    await call('GET', `/oauth/callback/mercadolibre?state=${state}&code=c`);
    const notif = (attempts: number) => ({
      resource: '/orders/555',
      user_id: 777,
      topic: 'orders_v2',
      application_id: 'test-app-id',
      attempts,
      sent: nowIso(),
      received: '2026-11-17T10:00:00.000Z',
    });
    const r1 = await call('POST', '/webhooks/mercadolibre', notif(1));
    const r2 = await call('POST', '/webhooks/mercadolibre', notif(2));
    const r3 = await call('POST', '/webhooks/mercadolibre', notif(3));
    expect([r1.json, r2.json, r3.json]).toEqual([
      { received: 1, duplicates: 0 },
      { received: 0, duplicates: 1 },
      { received: 0, duplicates: 1 },
    ]);
    const jobsList = (await call('GET', '/v1/automation/jobs', undefined, t)).json.items.filter(
      (j: Json) => j.type === 'channels.webhook_process',
    );
    expect(jobsList).toHaveLength(1);
    const [event] = (await call('GET', '/v1/channels/webhook-events', undefined, t)).json.items;
    const rt = {
      db: createDb(env.DB),
      tenantId: t,
      config: parseApiConfig({ ...env }),
      secrets: secretsFromEnv(env),
      now: new Date(),
    };
    await processWebhookEvent(rt, event.id);
    await processWebhookEvent(rt, event.id);
    const channelOrders = (await call('GET', '/v1/channels/orders', undefined, t)).json.items;
    expect(channelOrders).toHaveLength(1);
    const body = {
      buyerRef: 'ml-777',
      currency: 'ARS',
      channelOrderId: channelOrders[0].id,
      items: [{ productId, quantity: 1, unitPriceCents: 100_000 }],
    };
    expect((await call('POST', '/v1/orders', body, t)).status).toBe(201);
    expect((await call('POST', '/v1/orders', body, t)).status).toBe(409);
    expect((await call('GET', '/v1/orders', undefined, t)).json.items).toHaveLength(1);
  });
});

describe('F. Token vencido → suspende la integración', () => {
  it('un 401 del canal suspende la conexión (EXPIRED) y bloquea operaciones sin volver a llamar a la API', async () => {
    env = { ...env, ...TEST_SECRETS };
    const t = await tenantOf('aud-f');
    const conn = (
      await call(
        'POST',
        '/v1/channels/connections',
        { channel: 'MERCADO_LIBRE', mode: 'LIVE', displayName: 'ML' },
        t,
      )
    ).json;
    const start = await call(
      'POST',
      `/v1/channels/connections/${conn.id}/oauth/start`,
      undefined,
      t,
    );
    const state = new URL(start.json.authorizationUrl).searchParams.get('state') ?? '';
    let revoked = false;
    network((u) => {
      if (u.endsWith('/oauth/token'))
        return revoked
          ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
          : {
              access_token: 'a',
              token_type: 'bearer',
              expires_in: 21600,
              scope: 'read write',
              user_id: 9,
              refresh_token: 'r',
            };
      if (revoked) return new Response('{}', { status: 401 });
      return u.includes('/orders/search') ? { results: [] } : { id: 9, nickname: 'S' };
    });
    await call('GET', `/oauth/callback/mercadolibre?state=${state}&code=c`);
    expect(
      (await call('POST', `/v1/channels/connections/${conn.id}/orders/sync`, undefined, t)).status,
    ).toBe(200);

    revoked = true; // el vendedor revocó el permiso / el token dejó de valer
    const fail = await call(
      'POST',
      `/v1/channels/connections/${conn.id}/orders/sync`,
      undefined,
      t,
    );
    expect(fail.status).toBe(401);
    const [c1] = (await call('GET', '/v1/channels/connections', undefined, t)).json.items;
    expect(c1.status).toBe('EXPIRED');

    const before = fetchCalls.length;
    const blocked = await call('GET', `/v1/channels/connections/${conn.id}/catalog`, undefined, t);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.message).toContain('suspendida');
    expect(fetchCalls.length).toBe(before);

    // Verificar: el token se rechaza y la renovación falla → sigue EXPIRED.
    const check = await call('POST', `/v1/channels/connections/${conn.id}/check`, undefined, t);
    expect(check.json.status).toBe('EXPIRED');
  });
});

describe('G. Fallo de cola → se recupera desde D1', () => {
  it('si Queues falla al encolar, el trabajo queda en D1 y el Scheduler lo despacha después', async () => {
    const t = await tenantOf('aud-g');
    const db: Database = createDb(env.DB);
    const sent: { body: unknown }[] = [];
    let queueDown = true;
    const deps: AutomationDeps = {
      db,
      queue: {
        sendBatch: (m) => {
          if (queueDown) return Promise.reject(new Error('Queues no disponible'));
          sent.push(...m);
          return Promise.resolve();
        },
      },
      clock: { now: () => new Date(), sleep: () => Promise.resolve() },
      handlers: defaultHandlers,
      config: parseApiConfig({ APP_ENV: 'development' }),
      workerId: 'audit',
    };
    const created = await createJob(deps, t, { type: 'system.ping', payload: {} });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const stored = await db.select().from(jobs).where(eq(jobs.id, created.value.job.id)).get();
    expect(stored).toMatchObject({ status: 'PENDING', dispatchedAt: null });

    queueDown = false;
    await runSchedulerTick(deps);
    expect(sent).toHaveLength(1);
    const messages: ConsumedMessage[] = sent.map((m, i) => ({
      id: `m${String(i)}`,
      body: m.body,
      attempts: 1,
      ack: () => undefined,
      retry: () => undefined,
    }));
    await handleQueueBatch(deps, { queue: 'viralcommerce-jobs', messages });
    const done = await db.select().from(jobs).where(eq(jobs.id, created.value.job.id)).get();
    expect(done?.status).toBe('COMPLETED');
  });
});

describe('H. Usuario no autorizado → sin acceso a operaciones administrativas', () => {
  const prodEnv = () => ({ ...env, APP_ENV: 'production' }) as Env;
  it.each([
    ['POST', '/v1/orders'],
    ['GET', '/v1/command/overview'],
    ['POST', '/v1/command/rules/change-requests'],
    ['POST', '/v1/automation/jobs'],
    ['POST', '/v1/channels/connections'],
    ['POST', '/v1/finance/funds'],
    ['PATCH', '/v1/command/settings'],
  ])('producción: %s %s → 401 aunque se envíe un X-Tenant-Id válido', async (method, path) => {
    const t = await tenantOf('aud-h');
    const r = await call(method, path, method === 'GET' ? undefined : {}, t, prodEnv());
    expect(r.status).toBe(401);
  });

  it('producción: el listado y alta de espacios están deshabilitados', async () => {
    expect((await call('GET', '/v1/tenants', undefined, undefined, prodEnv())).status).toBe(403);
  });

  it('sin APP_ENV configurado se asume producción (fail-closed; corrección de auditoría)', async () => {
    const t = await tenantOf('aud-h2');
    const noEnv = { ...env } as Record<string, unknown>;
    delete noEnv['APP_ENV'];
    expect(
      (await call('GET', '/v1/command/overview', undefined, t, noEnv as unknown as Env)).status,
    ).toBe(401);
  });

  it('desarrollo: sin header o con un tenant inexistente → 401; recurso de otro tenant → 404', async () => {
    const a = await tenantOf('aud-h3');
    const b = await tenantOf('aud-h4');
    expect((await call('GET', '/v1/orders')).status).toBe(401);
    expect(
      (await call('GET', '/v1/orders', undefined, '00000000-0000-4000-8000-000000000000')).status,
    ).toBe(401);
    const product = (
      await call(
        'POST',
        '/v1/products',
        { title: 'Privado', salePriceCents: 1_000, currency: 'ARS' },
        a,
      )
    ).json;
    const o = (
      await call(
        'POST',
        '/v1/orders',
        {
          buyerRef: 'x1',
          currency: 'ARS',
          items: [{ productId: product.id, quantity: 1, unitPriceCents: 1_000 }],
        },
        a,
      )
    ).json;
    expect((await call('GET', `/v1/orders/${o.order.id}`, undefined, b)).status).toBe(404);
    expect(
      (await call('POST', `/v1/orders/${o.order.id}/cancel`, { reason: 'ataque' }, b)).status,
    ).toBe(404);
  });
});

describe('I. Un agente no puede modificar reglas críticas', () => {
  it('no existe agente que toque reglas; tipos desconocidos se rechazan; el payload no altera la configuración', async () => {
    const t = await tenantOf('aud-i');
    const types = [...defaultHandlers.keys()];
    expect(types.filter((x) => /rule|config|policy|setting|margin|guard/i.test(x))).toEqual([]);
    expect(
      (
        await call(
          'POST',
          '/v1/automation/jobs',
          { type: 'rules.update', payload: { MIN_NET_MARGIN_BPS: 0 } },
          t,
        )
      ).status,
    ).toBe(400);

    const sent: { body: unknown }[] = [];
    const db: Database = createDb(env.DB);
    const deps: AutomationDeps = {
      db,
      queue: {
        sendBatch: (m) => {
          sent.push(...m);
          return Promise.resolve();
        },
      },
      clock: { now: () => new Date(), sleep: () => Promise.resolve() },
      handlers: defaultHandlers,
      config: parseApiConfig({ APP_ENV: 'development' }),
      workerId: 'audit',
    };
    const job = await createJob(deps, t, {
      type: 'orders.reevaluate',
      payload: { MIN_NET_MARGIN_BPS: 0, COMMERCIAL_ACTIONS_ENABLED: true },
    });
    expect(job.ok).toBe(true);
    await handleQueueBatch(deps, {
      queue: 'viralcommerce-jobs',
      messages: sent.map((m, i) => ({
        id: `m${String(i)}`,
        body: m.body,
        attempts: 1,
        ack: () => undefined,
        retry: () => undefined,
      })),
    });
    const rules = (await call('GET', '/v1/command/rules', undefined, t)).json.items;
    expect(rules.find((r: Json) => r.key === 'MIN_NET_MARGIN_BPS').value).toBe('2000');
    expect(rules.find((r: Json) => r.key === 'COMMERCIAL_ACTIONS_ENABLED').value).toBe('false');
    // Por HTTP solo se registra una propuesta; la regla vigente no cambia.
    const p = await call(
      'POST',
      '/v1/command/rules/change-requests',
      {
        ruleKey: 'COMMERCIAL_ACTIONS_ENABLED',
        proposedValue: 'true',
        reason: 'Un agente intenta habilitar compras',
      },
      t,
    );
    expect(p.json.status).toBe('PENDING_AUTHORIZATION');
    expect((await call('GET', '/health')).json.commercialActionsEnabled).toBe(false);
  });
});

describe('J. Intento de compra real → bloqueado', () => {
  it('la orden de compra al proveedor, el reembolso y la publicación real se bloquean sin tocar terceros', async () => {
    env = { ...env, ...TEST_SECRETS };
    const t = await tenantOf('aud-j');
    const { productId } = await candidate(t);
    await call(
      'POST',
      '/v1/finance/funds',
      {
        availableCents: 500_000,
        currency: 'ARS',
        asOf: ago(1),
        source: 'MANUAL',
        sourceRef: 'Extracto',
      },
      t,
    );
    const o = (
      await call(
        'POST',
        '/v1/orders',
        {
          buyerRef: 'comprador-j',
          currency: 'ARS',
          items: [{ productId, quantity: 1, unitPriceCents: 100_000 }],
        },
        t,
      )
    ).json;
    const paid = await call(
      'POST',
      `/v1/orders/${o.order.id}/payments`,
      {
        provider: 'Mercado Pago',
        externalPaymentId: 'MP-J',
        status: 'APPROVED',
        amountCents: 100_000,
        currency: 'ARS',
        evidenceSource: 'PAYMENT_PROVIDER_REPORT',
        evidenceRef: 'Reporte J',
        observedAt: nowIso(),
      },
      t,
    );
    expect(paid.json.order.state).toBe('FINANCIAL_APPROVED');
    const buy = await call(
      'POST',
      `/v1/orders/${o.order.id}/dispatch-request`,
      { requestRef: 'OC-REAL' },
      t,
    );
    expect(buy.status).toBe(403);
    expect(buy.json.error.code).toBe('COMMERCIAL_ACTIONS_DISABLED');
    const after = (await call('GET', `/v1/orders/${o.order.id}`, undefined, t)).json;
    expect(after.supplierOrders[0].status).toBe('SELECTED');
    expect(after.events.some((e: Json) => e.type === 'DISPATCH_BLOCKED')).toBe(true);
    expect(
      (await call('POST', `/v1/orders/${o.order.id}/refund-execution`, undefined, t)).status,
    ).toBe(403);
    expect(fetchCalls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('Límites de Cloudflare Free: consultas D1 por solicitud', () => {
  it('mide consultas por operación (límite Free: 50 por invocación)', async () => {
    const t = await tenantOf('aud-limits');
    const { productId } = await candidate(t);
    await call(
      'POST',
      '/v1/finance/funds',
      {
        availableCents: 500_000,
        currency: 'ARS',
        asOf: ago(1),
        source: 'MANUAL',
        sourceRef: 'Extracto',
      },
      t,
    );
    const measure = async (fn: () => Promise<unknown>) => {
      queries = 0;
      await fn();
      return queries;
    };
    let orderId = '';
    const results = {
      overview: await measure(() => call('GET', '/v1/command/overview', undefined, t)),
      createOrder: await measure(async () => {
        orderId = (
          await call(
            'POST',
            '/v1/orders',
            {
              buyerRef: 'm1',
              currency: 'ARS',
              items: [{ productId, quantity: 1, unitPriceCents: 100_000 }],
            },
            t,
          )
        ).json.order.id;
      }),
      recordPaymentAndAdvance: await measure(() =>
        call(
          'POST',
          `/v1/orders/${orderId}/payments`,
          {
            provider: 'MP',
            externalPaymentId: 'MP-M',
            status: 'APPROVED',
            amountCents: 100_000,
            currency: 'ARS',
            evidenceSource: 'PAYMENT_PROVIDER_REPORT',
            evidenceRef: 'Reporte M',
            observedAt: nowIso(),
          },
          t,
        ),
      ),
      orderDetail: await measure(() => call('GET', `/v1/orders/${orderId}`, undefined, t)),
      listOrders: await measure(() => call('GET', '/v1/orders', undefined, t)),
    };
    console.info('[AUDIT D1 QUERIES]', JSON.stringify(results));
    // Lecturas simples dentro del límite; los flujos del motor de pedidos lo superan (ver AUDIT_REPORT.md).
    expect(results.listOrders).toBeLessThanOrEqual(50);
    expect(results.overview).toBeLessThanOrEqual(50);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@vc/database';
import { hmacSha256Hex } from '@vc/security';
import { parseApiConfig } from '@vc/shared';
import { createApp } from '../../apps/api/src/app';
import { secretsFromEnv, type Env } from '../../apps/api/src/env';
import { processWebhookEvent } from '../../apps/api/src/modules/channels/webhooks';
import { createTestD1 } from '../support/node-d1';

/**
 * Integración omnicanal: HTTP → servicios → SQLite real. SIN RED: `fetch` global
 * se reemplaza por un doble; si un test no lo configura, cualquier request falla.
 * Secrets y tokens son valores de PRUEBA, no credenciales reales.
 */
const app = createApp();
let env: Env;
let d1: ReturnType<typeof createTestD1>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const TEST_SECRETS = {
  TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1))),
  PUBLIC_API_URL: 'https://api.test.example',
  ML_APP_ID: 'test-app-id',
  ML_CLIENT_SECRET: 'test-client-secret',
  META_APP_SECRET: 'test-meta-secret',
  META_WEBHOOK_VERIFY_TOKEN: 'test-verify-token',
};

const call = async (
  method: string,
  path: string,
  body?: unknown,
  tenant?: string,
  extraHeaders: Record<string, string> = {},
) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders };
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await app.request(
    path,
    {
      method,
      headers,
      redirect: 'manual',
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    },
    env,
  );
  const text = await res.text();
  let json: Json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
};

const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const tenantOf = async (slug: string) =>
  (await call('POST', '/v1/tenants', { name: slug, slug })).json.id as string;

const connect = async (t: string, channel: string, mode: string) =>
  (
    await call(
      'POST',
      '/v1/channels/connections',
      { channel, mode, displayName: `${channel} ${mode}` },
      t,
    )
  ).json;

/** Doble de fetch: registra y responde según la URL. */
const network = (responder: (url: string, init?: RequestInit) => unknown) => {
  const calls: { url: string; method: string; body: string | null }[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const r = responder(url, init);
    return Promise.resolve(
      r instanceof Response
        ? r
        : new Response(JSON.stringify(r), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    );
  });
  return calls;
};

/* -------- Producto candidato real (proveedor verificado, stock, margen) -------- */

const SUPPLIER = {
  legalName: 'Proveedor Directo SRL',
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

const candidate = async (t: string, opts: { verify?: boolean } = {}) => {
  const supplier = (await call('POST', '/v1/suppliers', SUPPLIER, t)).json;
  const product = (
    await call(
      'POST',
      '/v1/products',
      { title: 'Organizador de cocina', salePriceCents: 100_000, currency: 'ARS' },
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
        supplierSku: 'ORG-1',
        title: 'Organizador de cocina de bambú',
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
  if (opts.verify !== false) {
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
  }
  const source = (
    await call('POST', '/v1/discovery/sources', { name: 'Catálogo', kind: 'SUPPLIER_CATALOG' }, t)
  ).json;
  await call('POST', `/v1/discovery/sources/${source.id}/sync`, undefined, t);
  const [dp] = (await call('GET', '/v1/discovery/products', undefined, t)).json.items;
  await call(
    'POST',
    `/v1/discovery/products/${dp.id}/images`,
    {
      url: 'https://cdn.example.com/organizador.jpg',
      authorization: 'SUPPLIER_WRITTEN',
      authorizationRef: 'mail-proveedor-2026',
    },
    t,
  );
  await call(
    'POST',
    `/v1/discovery/products/${dp.id}/images`,
    { url: 'https://cdn.example.com/sin-permiso.jpg', authorization: 'NONE' },
    t,
  );
  if (opts.verify !== false) {
    const promoted = await call('POST', `/v1/discovery/products/${dp.id}/promote`, undefined, t);
    expect(promoted.status).toBe(200);
    expect(
      (await call('POST', `/v1/discovery/products/${dp.id}/content`, undefined, t)).status,
    ).toBe(201);
  }
  return {
    discoveredId: dp.id as string,
    supplierId: supplier.id as string,
    productId: product.id as string,
  };
};

beforeEach(() => {
  d1 = createTestD1();
  env = {
    DB: d1,
    JOBS_QUEUE: { sendBatch: () => Promise.resolve() },
    APP_ENV: 'development',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    COMMERCIAL_ACTIONS_ENABLED: 'false',
  } as unknown as Env;
  network(() => new Response('sin red en tests', { status: 599 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conexiones: estados honestos', () => {
  it('LIVE sin secrets queda NOT_CONFIGURED indicando qué falta; nunca CONNECTED', async () => {
    const t = await tenantOf('t1');
    const ml = await connect(t, 'MERCADO_LIBRE', 'LIVE');
    expect(ml).toMatchObject({ status: 'NOT_CONFIGURED', mode: 'LIVE' });
    expect(ml.statusDetail).toContain('ML_APP_ID');
    const ig = await connect(t, 'INSTAGRAM', 'LIVE');
    expect(ig.statusDetail).toContain('INSTAGRAM_APP_ID');
    const wa = await connect(t, 'WHATSAPP', 'LIVE');
    expect(wa.statusDetail).toContain('TOKEN_ENCRYPTION_KEY');
    expect((await connect(t, 'AFFILIATE', 'LIVE')).status).toBe('NOT_CONFIGURED');
    expect((await connect(t, 'OWN_STORE', 'LIVE')).status).toBe('CONNECTED');
    const start = await call('POST', `/v1/channels/connections/${ml.id}/oauth/start`, undefined, t);
    expect(start.status).toBe(503);
  });

  it('MOCK queda CONNECTED pero marcado como simulación, con capacidades reales del canal', async () => {
    const t = await tenantOf('t1');
    const ig = await connect(t, 'INSTAGRAM', 'MOCK');
    expect(ig).toMatchObject({
      status: 'CONNECTED',
      mode: 'MOCK',
      externalAccountId: 'mock-account',
    });
    expect(ig.statusDetail).toMatch(/MOCK/);
    expect(ig.capabilities.updateListing.support).toBe('UNSUPPORTED');
    expect(ig.capabilities.getOrders.support).toBe('UNSUPPORTED');
  });

  it('las conexiones están aisladas por tenant', async () => {
    const a = await tenantOf('tenant-a');
    const b = await tenantOf('tenant-b');
    const conn = await connect(a, 'MERCADO_LIBRE', 'MOCK');
    expect(
      (await call('POST', `/v1/channels/connections/${conn.id}/check`, undefined, b)).status,
    ).toBe(404);
    expect((await call('GET', '/v1/channels/connections', undefined, b)).json.items).toEqual([]);
  });
});

describe('OAuth Mercado Libre (con secrets de prueba y red simulada)', () => {
  beforeEach(() => {
    env = { ...env, ...TEST_SECRETS };
  });

  it('state de un solo uso + PKCE; tokens cifrados y nunca expuestos', async () => {
    const t = await tenantOf('t1');
    const conn = await connect(t, 'MERCADO_LIBRE', 'LIVE');
    expect(conn.statusDetail).toBe('Pendiente: autorizar la cuenta (OAuth)');
    const start = await call(
      'POST',
      `/v1/channels/connections/${conn.id}/oauth/start`,
      undefined,
      t,
    );
    expect(start.status).toBe(200);
    const url = new URL(start.json.authorizationUrl);
    const state = url.searchParams.get('state') ?? '';
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.test.example/oauth/callback/mercadolibre',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const calls = network((u) =>
      u.endsWith('/oauth/token')
        ? {
            access_token: 'APP_USR-secret-test',
            token_type: 'bearer',
            expires_in: 21600,
            scope: 'offline_access read write',
            user_id: 468424240,
            refresh_token: 'TG-secret-test',
          }
        : u.endsWith('/users/me')
          ? { id: 468424240, nickname: 'TESTSELLER' }
          : new Response('{}', { status: 404 }),
    );
    const bad = await call('GET', `/oauth/callback/mercadolibre?state=otro&code=c1`);
    expect(bad.status).toBe(400);
    const cb = await call('GET', `/oauth/callback/mercadolibre?state=${state}&code=c1`);
    expect(cb.status).toBe(200);
    const verifier = new URLSearchParams(calls[0]?.body ?? '').get('code_verifier');
    expect(verifier).toBeTruthy();
    const replay = await call('GET', `/oauth/callback/mercadolibre?state=${state}&code=c1`);
    expect(replay.status).toBe(400);

    const [listed] = (await call('GET', '/v1/channels/connections', undefined, t)).json.items;
    expect(listed).toMatchObject({
      status: 'CONNECTED',
      externalAccountId: '468424240',
      externalAccountName: 'TESTSELLER',
    });
    expect(JSON.stringify(listed)).not.toContain('secret-test');
    const raw = (await d1
      .prepare('SELECT access_token_enc, refresh_token_enc FROM channel_connections')
      .first()) as Record<string, string> | null;
    expect(raw?.['access_token_enc']).toMatch(/^v1\./);
    expect(JSON.stringify(raw)).not.toContain('secret-test');
  });

  it('token vencido: el chequeo renueva con refresh_token antes de informar EXPIRED', async () => {
    const t = await tenantOf('t1');
    const conn = await connect(t, 'MERCADO_LIBRE', 'LIVE');
    const start = await call(
      'POST',
      `/v1/channels/connections/${conn.id}/oauth/start`,
      undefined,
      t,
    );
    const state = new URL(start.json.authorizationUrl).searchParams.get('state') ?? '';
    let issued = 0;
    const calls = network((u) => {
      if (u.endsWith('/oauth/token')) {
        issued++;
        // El primero ya viene vencido (expires_in mínimo) para forzar la renovación.
        return {
          access_token: `tok-${issued}`,
          token_type: 'bearer',
          expires_in: issued === 1 ? 1 : 21600,
          scope: 'read write',
          user_id: 1,
          refresh_token: `rt-${issued}`,
        };
      }
      return { id: 1, nickname: 'S' };
    });
    await call('GET', `/oauth/callback/mercadolibre?state=${state}&code=c`);
    await new Promise((r) => setTimeout(r, 1100));
    const checked = await call('POST', `/v1/channels/connections/${conn.id}/check`, undefined, t);
    expect(checked.json.status).toBe('CONNECTED');
    expect(
      calls
        .filter((c) => c.url.endsWith('/oauth/token'))
        .map((c) => new URLSearchParams(c.body ?? '').get('grant_type')),
    ).toEqual(['authorization_code', 'refresh_token']);
    const logs = (await call('GET', '/v1/channels/logs', undefined, t)).json.items;
    expect(logs.some((l: Json) => l.operation === 'refreshTokens' && l.outcome === 'OK')).toBe(
      true,
    );
  });

  it('desconectar borra los tokens locales', async () => {
    const t = await tenantOf('t1');
    const conn = await connect(t, 'MERCADO_LIBRE', 'LIVE');
    const r = await call('POST', `/v1/channels/connections/${conn.id}/disconnect`, undefined, t);
    expect(r.json.status).toBe('NOT_CONFIGURED');
    const raw = await d1.prepare('SELECT access_token_enc FROM channel_connections').first();
    expect(raw?.['access_token_enc']).toBeNull();
  });
});

describe('publicaciones: condiciones y modo simulación', () => {
  it('prepara con datos reales, excluye imágenes sin autorización y publica en MOCK', async () => {
    const t = await tenantOf('t1');
    const { discoveredId } = await candidate(t);
    const conn = await connect(t, 'OWN_STORE', 'MOCK');
    const prep = await call(
      'POST',
      '/v1/channels/listings',
      { connectionId: conn.id, discoveredProductId: discoveredId },
      t,
    );
    expect(prep.status).toBe(201);
    expect(prep.json.draft.imageUrls).toEqual(['https://cdn.example.com/organizador.jpg']);
    expect(prep.json.draft.priceCents).toBe(100_000);
    expect(prep.json.status).toBe('READY');
    expect(prep.json.gate).toMatchObject({ allowed: false, allowedInMock: true });

    const pub = await call('POST', `/v1/channels/listings/${prep.json.id}/publish`, undefined, t);
    expect(pub.status).toBe(200);
    expect(pub.json).toMatchObject({ status: 'PUBLISHED', mode: 'MOCK' });
    expect(pub.json.externalId).toMatch(/^mock-/);
    // MOCK no aparece en la tienda pública.
    expect((await call('GET', '/store/t1/products')).json.items).toEqual([]);
  });

  it('LIVE conectado: publicación bloqueada por COMMERCIAL_ACTIONS_ENABLED=false sin tocar la API', async () => {
    env = { ...env, ...TEST_SECRETS };
    const t = await tenantOf('t1');
    const { discoveredId } = await candidate(t);
    const conn = await connect(t, 'MERCADO_LIBRE', 'LIVE');
    const start = await call(
      'POST',
      `/v1/channels/connections/${conn.id}/oauth/start`,
      undefined,
      t,
    );
    const state = new URL(start.json.authorizationUrl).searchParams.get('state') ?? '';
    const calls = network((u) =>
      u.endsWith('/oauth/token')
        ? {
            access_token: 'a',
            token_type: 'bearer',
            expires_in: 21600,
            scope: 'offline_access read write',
            user_id: 9,
            refresh_token: 'r',
          }
        : { id: 9, nickname: 'S' },
    );
    await call('GET', `/oauth/callback/mercadolibre?state=${state}&code=c`);
    const prep = await call(
      'POST',
      '/v1/channels/listings',
      {
        connectionId: conn.id,
        discoveredProductId: discoveredId,
        categoryId: 'MLA1234',
        listingTypeId: 'gold_pro',
        condition: 'new',
        quantity: 2,
      },
      t,
    );
    const failed = prep.json.gate.checks.filter((c: Json) => !c.passed).map((c: Json) => c.check);
    expect(failed).toEqual(['COMMERCIAL_ACTIONS_ENABLED']);
    expect(prep.json.status).toBe('BLOCKED');
    const pub = await call('POST', `/v1/channels/listings/${prep.json.id}/publish`, undefined, t);
    expect(pub.status).toBe(409);
    expect(calls.some((c) => c.url.endsWith('/items'))).toBe(false);
  });

  it('proveedor sin verificar: ni siquiera se puede preparar (no es candidato) y MOCK no simula', async () => {
    const t = await tenantOf('t1');
    const { discoveredId } = await candidate(t, { verify: false });
    const conn = await connect(t, 'MERCADO_LIBRE', 'MOCK');
    const prep = await call(
      'POST',
      '/v1/channels/listings',
      { connectionId: conn.id, discoveredProductId: discoveredId },
      t,
    );
    expect(prep.status).toBe(409);
  });

  it('políticas del canal: Mercado Libre sin categoría queda BLOCKED también en MOCK', async () => {
    const t = await tenantOf('t1');
    const { discoveredId } = await candidate(t);
    const conn = await connect(t, 'MERCADO_LIBRE', 'MOCK');
    const prep = await call(
      'POST',
      '/v1/channels/listings',
      { connectionId: conn.id, discoveredProductId: discoveredId },
      t,
    );
    expect(prep.json.status).toBe('BLOCKED');
    expect(prep.json.gate.checks.find((c: Json) => c.check === 'CHANNEL_POLICY').detail).toContain(
      'categoría',
    );
    const pub = await call('POST', `/v1/channels/listings/${prep.json.id}/publish`, undefined, t);
    expect(pub.status).toBe(409);
    const logs = (await call('GET', '/v1/channels/logs', undefined, t)).json.items;
    expect(logs[0]).toMatchObject({ outcome: 'BLOCKED', errorCode: 'PUBLISH_GATE' });
  });

  it('vista previa de tienda: HTML escapado y aviso de que no está a la venta; checkout 503', async () => {
    const t = await tenantOf('t1');
    const { discoveredId } = await candidate(t);
    const conn = await connect(t, 'OWN_STORE', 'MOCK');
    const prep = await call(
      'POST',
      '/v1/channels/listings',
      { connectionId: conn.id, discoveredProductId: discoveredId },
      t,
    );
    const html = await call('GET', `/v1/channels/listings/${prep.json.id}/preview`, undefined, t);
    expect(html.json).toContain('Vista previa');
    expect(html.json).toContain('Compra no disponible');
    const checkout = await call('POST', '/store/t1/checkout', {});
    expect(checkout.status).toBe(503);
    expect(checkout.json.error.message).toContain('No se simulan pagos');
  });
});

describe('webhooks', () => {
  beforeEach(() => {
    env = { ...env, ...TEST_SECRETS };
  });

  const linkMl = async (t: string) => {
    const conn = await connect(t, 'MERCADO_LIBRE', 'LIVE');
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
            user_id: 468424240,
            refresh_token: 'r',
          }
        : u.includes('/orders/2195160686')
          ? {
              id: 2195160686,
              status: 'paid',
              total_amount: 2500,
              currency_id: 'ARS',
              date_created: '2026-11-17T10:00:00.000-03:00',
            }
          : { id: 468424240, nickname: 'S' },
    );
    await call('GET', `/oauth/callback/mercadolibre?state=${state}&code=c`);
    return conn;
  };

  it('Mercado Libre: valida application_id, deduplica reintentos y procesa consultando el recurso', async () => {
    const t = await tenantOf('t1');
    const conn = await linkMl(t);
    const notif = (appId: string, attempts = 1) => ({
      resource: '/orders/2195160686',
      user_id: 468424240,
      topic: 'orders_v2',
      application_id: appId,
      attempts,
      sent: '2026-11-17T13:00:00.000Z',
      received: '2026-11-17T13:00:00.000Z',
    });
    expect((await call('POST', '/webhooks/mercadolibre', notif('otra-app'))).status).toBe(401);
    const first = await call('POST', '/webhooks/mercadolibre', notif('test-app-id'));
    expect(first.json).toEqual({ received: 1, duplicates: 0 });
    const retry = await call('POST', '/webhooks/mercadolibre', notif('test-app-id', 2));
    expect(retry.json).toEqual({ received: 0, duplicates: 1 });

    const jobs = (await call('GET', '/v1/automation/jobs', undefined, t)).json.items;
    expect(jobs.filter((j: Json) => j.type === 'channels.webhook_process')).toHaveLength(1);

    const [event] = (await call('GET', '/v1/channels/webhook-events', undefined, t)).json.items;
    expect(event).toMatchObject({ status: 'RECEIVED', connectionId: conn.id });
    const r = await processWebhookEvent(
      {
        db: createDb(env.DB),
        tenantId: t,
        config: parseApiConfig({ ...env }),
        secrets: secretsFromEnv(env),
        now: new Date(),
      },
      event.id,
    );
    expect(r.ok && r.value.status).toBe('PROCESSED');
    const [order] = (await call('GET', '/v1/channels/orders', undefined, t)).json.items;
    expect(order).toMatchObject({
      externalOrderId: '2195160686',
      status: 'PAID',
      rawStatus: 'paid',
      totalCents: 250_000,
    });
  });

  it('WhatsApp: challenge GET, firma obligatoria y mensajes entrantes registrados', async () => {
    const t = await tenantOf('t1');
    const conn = await connect(t, 'WHATSAPP', 'LIVE');
    network(() => ({
      id: '106540352242922',
      verified_name: 'Negocio de prueba',
      quality_rating: 'GREEN',
    }));
    const linked = await call(
      'POST',
      `/v1/channels/connections/${conn.id}/token`,
      { accessToken: 'test-system-user-token-0000', phoneNumberId: '106540352242922' },
      t,
    );
    expect(linked.json).toMatchObject({
      status: 'CONNECTED',
      externalAccountName: 'Negocio de prueba',
    });

    const ch = await call(
      'GET',
      '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=987',
    );
    expect(ch).toMatchObject({ status: 200, json: 987 });
    expect(
      (
        await call(
          'GET',
          '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1',
        )
      ).status,
    ).toBe(401);

    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '106540352242922' },
                messages: [
                  {
                    id: 'wamid.IN1',
                    from_user_id: 'AR.1',
                    type: 'text',
                    text: { body: 'Hola, ¿tienen stock?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(
      (
        await call('POST', '/webhooks/whatsapp', body, undefined, {
          'x-hub-signature-256': 'sha256=00',
        })
      ).status,
    ).toBe(401);
    const ok = await call('POST', '/webhooks/whatsapp', body, undefined, {
      'x-hub-signature-256': `sha256=${await hmacSha256Hex('test-meta-secret', body)}`,
    });
    expect(ok.json).toEqual({ received: 1, duplicates: 0 });
    const [event] = (await call('GET', '/v1/channels/webhook-events', undefined, t)).json.items;
    await processWebhookEvent(
      {
        db: createDb(env.DB),
        tenantId: t,
        config: parseApiConfig({ ...env }),
        secrets: secretsFromEnv(env),
        now: new Date(),
      },
      event.id,
    );
    const [msg] = (await call('GET', '/v1/channels/messages', undefined, t)).json.items;
    expect(msg).toMatchObject({
      direction: 'INBOUND',
      contactRef: 'AR.1',
      body: 'Hola, ¿tienen stock?',
    });

    // Respuesta dentro de la ventana: igual queda BLOCKED por el interruptor comercial.
    const draft = await call(
      'POST',
      '/v1/channels/messages',
      { connectionId: conn.id, contactRef: 'AR.1', text: 'Sí, hay stock' },
      t,
    );
    const sent = await call('POST', `/v1/channels/messages/${draft.json.id}/send`, undefined, t);
    expect(sent.json).toMatchObject({ status: 'BLOCKED' });
    expect(sent.json.detail).toContain('modo simulación');
    // Fuera de ventana (contacto que nunca escribió): solo plantillas.
    const cold = await call(
      'POST',
      '/v1/channels/messages',
      { connectionId: conn.id, contactRef: '5491100000000', text: 'Hola' },
      t,
    );
    const coldSent = await call('POST', `/v1/channels/messages/${cold.json.id}/send`, undefined, t);
    expect(coldSent.json.detail).toContain('24 h');
  });

  it('webhook de cuenta desconocida se guarda IGNORED y no crea trabajos', async () => {
    const t = await tenantOf('t1');
    const r = await call('POST', '/webhooks/mercadolibre', {
      resource: '/items/MLA1',
      user_id: 1,
      topic: 'items',
      application_id: 'test-app-id',
    });
    expect(r.json).toEqual({ received: 1, duplicates: 0 });
    expect((await call('GET', '/v1/channels/webhook-events', undefined, t)).json.items).toEqual([]);
  });
});

describe('mensajes MOCK', () => {
  it('el envío MOCK se simula sin red y queda registrado como simulado', async () => {
    const t = await tenantOf('t1');
    const conn = await connect(t, 'WHATSAPP', 'MOCK');
    const d = await call(
      'POST',
      '/v1/channels/messages',
      {
        connectionId: conn.id,
        contactRef: '549',
        template: { name: 'pedido_listo', languageCode: 'es_AR', parameters: ['Ana'] },
      },
      t,
    );
    const s = await call('POST', `/v1/channels/messages/${d.json.id}/send`, undefined, t);
    expect(s.json).toMatchObject({ status: 'SENT', kind: 'TEMPLATE' });
    expect(s.json.detail).toContain('MOCK');
  });
});

describe('afiliados', () => {
  it('redes, productos con tasa respaldada, enlaces, clics, conversiones y comisiones', async () => {
    const t = await tenantOf('t1');
    const net = (
      await call(
        'POST',
        '/v1/affiliates/networks',
        { name: 'Red de prueba', website: 'https://red.example.com' },
        t,
      )
    ).json;
    expect(net.status).toBe('NOT_CONFIGURED');
    const noSource = await call(
      'POST',
      '/v1/affiliates/products',
      {
        networkId: net.id,
        title: 'Auriculares',
        productUrl: 'https://red.example.com/p/1',
        commissionRateBps: 800,
      },
      t,
    );
    expect(noSource.status).toBe(400);
    const prod = (
      await call(
        'POST',
        '/v1/affiliates/products',
        {
          networkId: net.id,
          title: 'Auriculares',
          productUrl: 'https://red.example.com/p/1',
          commissionRateBps: 800,
          commissionSourceRef: 'Panel de la red, 2026-11',
        },
        t,
      )
    ).json;
    expect(
      (
        await call(
          'POST',
          '/v1/affiliates/links',
          { productId: prod.id, destinationUrl: 'http://inseguro.example.com' },
          t,
        )
      ).status,
    ).toBe(400);
    const link = (
      await call(
        'POST',
        '/v1/affiliates/links',
        {
          productId: prod.id,
          destinationUrl: 'https://red.example.com/track?id=abc',
          campaign: 'ig-nov',
        },
        t,
      )
    ).json;

    const click = await call('GET', `/r/${link.code}`, undefined, undefined, {
      referer: 'https://instagram.com/p/x',
      'cf-ipcountry': 'AR',
    });
    expect(click.status).toBe(302);
    expect(click.headers.get('location')).toBe('https://red.example.com/track?id=abc');
    expect((await call('GET', '/r/inexistente')).status).toBe(404);
    const clickRow = (await d1
      .prepare('SELECT referrer_host, country FROM affiliate_clicks')
      .first()) as Record<string, string> | null;
    expect(clickRow).toEqual({ referrer_host: 'instagram.com', country: 'AR' });

    const conv = await call(
      'POST',
      '/v1/affiliates/conversions',
      {
        linkId: link.id,
        externalRef: 'ORD-1',
        saleCents: 50_000,
        currency: 'ARS',
        sourceRef: 'Reporte red 2026-11-17',
        occurredAt: ago(2),
      },
      t,
    );
    expect(conv.json).toMatchObject({
      commissionCents: 4_000,
      status: 'PENDING',
      source: 'MANUAL',
    });
    const dup = await call(
      'POST',
      '/v1/affiliates/conversions',
      {
        linkId: link.id,
        externalRef: 'ORD-1',
        saleCents: 50_000,
        currency: 'ARS',
        sourceRef: 'Reporte',
        occurredAt: ago(2),
      },
      t,
    );
    expect(dup.status).toBe(409);
    const future = await call(
      'POST',
      '/v1/affiliates/conversions',
      {
        linkId: link.id,
        externalRef: 'ORD-2',
        saleCents: 1,
        currency: 'ARS',
        sourceRef: 'Reporte',
        occurredAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      t,
    );
    expect(future.status).toBe(400);
    await call('PATCH', `/v1/affiliates/conversions/${conv.json.id}`, { status: 'APPROVED' }, t);

    const summary = (await call('GET', '/v1/affiliates/summary', undefined, t)).json;
    expect(summary).toEqual({
      clicks: 1,
      conversions: 1,
      conversionRateBps: 10_000,
      commissions: [{ currency: 'ARS', status: 'APPROVED', totalCents: 4_000 }],
    });
    const [listed] = (await call('GET', '/v1/affiliates/links', undefined, t)).json.items;
    expect(listed).toMatchObject({ clicks: 1, conversions: 1 });
    await call('PATCH', `/v1/affiliates/links/${link.id}`, { active: false }, t);
    expect((await call('GET', `/r/${link.code}`)).status).toBe(404);
  });

  it('sin tasa registrada exige la comisión informada (no se estima)', async () => {
    const t = await tenantOf('t1');
    const net = (await call('POST', '/v1/affiliates/networks', { name: 'Red' }, t)).json;
    const prod = (
      await call(
        'POST',
        '/v1/affiliates/products',
        { networkId: net.id, title: 'Producto X', productUrl: 'https://r.example.com/x' },
        t,
      )
    ).json;
    const link = (
      await call(
        'POST',
        '/v1/affiliates/links',
        { productId: prod.id, destinationUrl: 'https://r.example.com/t' },
        t,
      )
    ).json;
    const r = await call(
      'POST',
      '/v1/affiliates/conversions',
      {
        linkId: link.id,
        externalRef: 'A',
        saleCents: 100,
        currency: 'ARS',
        sourceRef: 'Reporte de la red',
        occurredAt: ago(1),
      },
      t,
    );
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain('comisión');
  });
});

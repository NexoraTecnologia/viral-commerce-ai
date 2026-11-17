import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app';
import type { Env } from '../../apps/api/src/env';
import { createTestD1 } from '../support/node-d1';

/** Command Center: lecturas agregadas con datos reales (o vacías), reglas y configuración. */
const app = createApp();
let env: Env;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const call = async (method: string, path: string, body?: unknown, tenant?: string) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await app.request(
    path,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    env,
  );
  return { status: res.status, json: (await res.json()) as Json };
};

const tenantOf = async (slug: string) =>
  (await call('POST', '/v1/tenants', { name: slug, slug })).json.id as string;

beforeEach(() => {
  env = {
    DB: createTestD1(),
    JOBS_QUEUE: { sendBatch: () => Promise.resolve() },
    APP_ENV: 'development',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    COMMERCIAL_ACTIONS_ENABLED: 'false',
    ML_APP_ID: 'test-app-id',
  } as unknown as Env;
});

describe('overview', () => {
  it('espacio vacío: todo en cero o vacío, nada inventado; recursos no medidos quedan null', async () => {
    const t = await tenantOf('tienda-vacia');
    const o = (await call('GET', '/v1/command/overview', undefined, t)).json;
    expect(o.sales).toEqual({ last30d: [], total: [], paidOrders: 0 });
    expect(o.netProfit).toEqual({ settledOrders: 0, net: [] });
    expect(o.orders.total).toBe(0);
    expect(o.commercialActionsEnabled).toBe(false);
    const byName = Object.fromEntries(o.freeTier.map((r: Json) => [r.resource, r]));
    expect(byName['Workers: solicitudes por día']).toMatchObject({ used: null, limit: 100_000 });
    expect(byName['Cron Triggers por cuenta']).toMatchObject({ used: 2, limit: 5 });
    expect(byName['Queues: operaciones por día'].limit).toBe(10_000);
  });

  it('ventas reales = cobros con evidencia; un pedido sin pago no suma', async () => {
    const t = await tenantOf('tienda-a');
    const product = (
      await call(
        'POST',
        '/v1/products',
        { title: 'Producto X', salePriceCents: 50_000, currency: 'ARS' },
        t,
      )
    ).json;
    const items = [{ productId: product.id, quantity: 1, unitPriceCents: 50_000 }];
    const paid = (
      await call('POST', '/v1/orders', { buyerRef: 'comprador-1', currency: 'ARS', items }, t)
    ).json;
    await call('POST', '/v1/orders', { buyerRef: 'comprador-2', currency: 'ARS', items }, t);
    await call(
      'POST',
      `/v1/orders/${paid.order.id}/payments`,
      {
        provider: 'Mercado Pago',
        externalPaymentId: 'MP-9',
        status: 'APPROVED',
        amountCents: 50_000,
        currency: 'ARS',
        evidenceSource: 'PAYMENT_PROVIDER_REPORT',
        evidenceRef: 'Reporte de prueba',
        observedAt: new Date().toISOString(),
      },
      t,
    );
    const o = (await call('GET', '/v1/command/overview', undefined, t)).json;
    expect(o.sales.total).toEqual([{ currency: 'ARS', cents: 50_000 }]);
    expect(o.sales.paidOrders).toBe(1);
    expect(o.netProfit.net).toEqual([]);
    expect(o.orders.total).toBe(2);

    const customers = (await call('GET', '/v1/command/customers', undefined, t)).json.items;
    expect(customers.find((c: Json) => c.buyerRef === 'comprador-1').paid).toEqual([
      { currency: 'ARS', cents: 50_000 },
    ]);
    expect(customers.find((c: Json) => c.buyerRef === 'comprador-2').paid).toEqual([]);
    expect((await call('GET', '/v1/command/shipments', undefined, t)).json.items).toEqual([]);
  });

  it('aislado por tenant', async () => {
    const a = await tenantOf('tienda-a');
    const b = await tenantOf('tienda-b');
    const product = (
      await call(
        'POST',
        '/v1/products',
        { title: 'Producto X', salePriceCents: 1_000, currency: 'ARS' },
        a,
      )
    ).json;
    await call(
      'POST',
      '/v1/orders',
      {
        buyerRef: 'x1',
        currency: 'ARS',
        items: [{ productId: product.id, quantity: 1, unitPriceCents: 1_000 }],
      },
      a,
    );
    expect((await call('GET', '/v1/command/overview', undefined, b)).json.orders.total).toBe(0);
    expect((await call('GET', '/v1/command/customers', undefined, b)).json.items).toEqual([]);
  });
});

describe('reglas', () => {
  it('lista reglas vigentes y registra propuestas SIN aplicarlas', async () => {
    const t = await tenantOf('tienda-a');
    const rules = (await call('GET', '/v1/command/rules', undefined, t)).json.items;
    const margin = rules.find((r: Json) => r.key === 'MIN_NET_MARGIN_BPS');
    expect(margin).toMatchObject({ value: '2000', financial: true });
    const bad = await call(
      'POST',
      '/v1/command/rules/change-requests',
      { ruleKey: 'MIN_NET_MARGIN_BPS', proposedValue: 'veinte', reason: 'Bajar el margen mínimo' },
      t,
    );
    expect(bad.status).toBe(400);
    const same = await call(
      'POST',
      '/v1/command/rules/change-requests',
      { ruleKey: 'MIN_NET_MARGIN_BPS', proposedValue: '2000', reason: 'Mismo valor de prueba' },
      t,
    );
    expect(same.status).toBe(400);
    const p = await call(
      'POST',
      '/v1/command/rules/change-requests',
      {
        ruleKey: 'MIN_NET_MARGIN_BPS',
        proposedValue: '1500',
        reason: 'Probar margen más bajo en temporada',
      },
      t,
    );
    expect(p.status).toBe(201);
    expect(p.json).toMatchObject({
      status: 'PENDING_AUTHORIZATION',
      financial: true,
      currentValue: '2000',
    });
    // La regla vigente NO cambió.
    const after = (await call('GET', '/v1/command/rules', undefined, t)).json.items;
    expect(after.find((r: Json) => r.key === 'MIN_NET_MARGIN_BPS').value).toBe('2000');
    const w = await call(
      'POST',
      `/v1/command/rules/change-requests/${p.json.id}/withdraw`,
      undefined,
      t,
    );
    expect(w.json.status).toBe('WITHDRAWN');
    // Queda en auditoría.
    const audit = (
      await call('GET', '/v1/command/audit?source=SYSTEM&page=1&pageSize=10', undefined, t)
    ).json;
    expect(audit.items.some((e: Json) => e.action === 'rules.change_proposed')).toBe(true);
  });
});

describe('auditoría y configuración', () => {
  it('auditoría paginada en el servidor con búsqueda', async () => {
    const t = await tenantOf('tienda-a');
    for (let i = 0; i < 7; i++) {
      await call(
        'POST',
        '/v1/command/rules/change-requests',
        {
          ruleKey: 'MAX_STOCK_AGE_HOURS',
          proposedValue: String(30 + i),
          reason: `Propuesta número ${String(i)}`,
        },
        t,
      );
    }
    const p1 = (
      await call('GET', '/v1/command/audit?source=SYSTEM&page=1&pageSize=5', undefined, t)
    ).json;
    expect(p1).toMatchObject({ total: 7, page: 1, pageSize: 5 });
    expect(p1.items).toHaveLength(5);
    const p2 = (
      await call('GET', '/v1/command/audit?source=SYSTEM&page=2&pageSize=5', undefined, t)
    ).json;
    expect(p2.items).toHaveLength(2);
    const none = (
      await call(
        'GET',
        '/v1/command/audit?source=SYSTEM&page=1&pageSize=5&q=inexistente',
        undefined,
        t,
      )
    ).json;
    expect(none.total).toBe(0);
    expect((await call('GET', '/v1/command/audit?pageSize=1000', undefined, t)).status).toBe(400);
  });

  it('configuración informa presencia de secrets sin exponer valores', async () => {
    const t = await tenantOf('tienda-a');
    const s = (await call('GET', '/v1/command/settings', undefined, t)).json;
    expect(s.secrets.find((x: Json) => x.name === 'ML_APP_ID')).toEqual({
      name: 'ML_APP_ID',
      configured: true,
      purpose: 'App de Mercado Libre',
    });
    expect(s.secrets.find((x: Json) => x.name === 'TOKEN_ENCRYPTION_KEY').configured).toBe(false);
    expect(JSON.stringify(s)).not.toContain('test-app-id');
    const r = await call('PATCH', '/v1/command/settings', { name: 'Tienda Renombrada' }, t);
    expect(r.json.tenant.name).toBe('Tienda Renombrada');
  });
});

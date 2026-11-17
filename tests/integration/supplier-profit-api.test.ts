import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app';
import type { Env } from '../../apps/api/src/env';
import { createTestD1 } from '../support/node-d1';

/**
 * Tests de integración de punta a punta: HTTP → Hono → reglas → Drizzle → SQLite
 * real con las migraciones del repo. Sin red ni integraciones externas.
 * Los montos son escenarios sintéticos de prueba.
 */
const app = createApp();
let env: Env;

// Respuestas JSON dinámicas: en tests se accede sin tipar (reglas relajadas en eslint).
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const call = async (
  method: string,
  path: string,
  body?: unknown,
  tenantId?: string,
): Promise<{ status: number; json: Json }> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (tenantId) headers['x-tenant-id'] = tenantId;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(path, init, env);
  return { status: res.status, json: (await res.json()) as Json };
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const createTenant = async (slug: string) => {
  const r = await call('POST', '/v1/tenants', { name: `Tenant ${slug}`, slug });
  expect(r.status).toBe(201);
  return r.json.id as string;
};

const SUPPLIER = {
  legalName: 'Distribuidora Ejemplo SRL',
  countryCode: 'AR',
  province: 'Buenos Aires',
  contacts: [{ name: 'Ventas', email: 'ventas@example.com' }],
  paymentMethods: ['BANK_TRANSFER'],
  directDispatch: true,
  dispatchLeadTimeDaysMax: 1,
  deliveryTimeDaysMax: 5,
  acceptsReturns: true,
  returnWindowDays: 30,
  trackingAvailable: true,
  requiresPrepayment: true,
  paymentDueDays: 0,
};

const COSTS = [
  { kind: 'SHIPPING', name: 'Envío', fixedCents: 5_000 },
  { kind: 'CHANNEL_COMMISSION', name: 'Comisión canal', rateBps: 1_300 },
  { kind: 'PAYMENT_PROCESSING', name: 'Cobro', rateBps: 400, fixedCents: 100 },
  { kind: 'TAX', name: 'Impuesto', rateBps: 300 },
  { kind: 'WITHHOLDING', name: 'Retención', rateBps: 200 },
  { kind: 'RETURN_RESERVE', name: 'Reserva devoluciones', rateBps: 300 },
];

/** Lleva un proveedor a VERIFIED registrando y aceptando la evidencia obligatoria. */
const verifySupplier = async (tenant: string, supplierId: string) => {
  expect(
    (
      await call(
        'POST',
        `/v1/suppliers/${supplierId}/status`,
        { to: 'UNDER_REVIEW', reason: 'Inicio de revisión' },
        tenant,
      )
    ).status,
  ).toBe(200);
  for (const category of ['IDENTITY', 'COMMERCIAL_TERMS', 'DISPATCH_CAPABILITY']) {
    const ev = await call(
      'POST',
      `/v1/suppliers/${supplierId}/evidence`,
      { category, description: `Evidencia de ${category}`, reference: `DOC-${category}` },
      tenant,
    );
    expect(ev.status).toBe(201);
    expect(ev.json.reviewStatus).toBe('PENDING');
    const review = await call(
      'POST',
      `/v1/suppliers/${supplierId}/evidence/${ev.json.id}/review`,
      { decision: 'ACCEPTED' },
      tenant,
    );
    expect(review.status).toBe(200);
  }
  return call(
    'POST',
    `/v1/suppliers/${supplierId}/status`,
    { to: 'VERIFIED', reason: 'Evidencia completa' },
    tenant,
  );
};

/** Crea producto + costos + oferta vinculada. */
const setupProduct = async (
  tenant: string,
  supplierId: string,
  offer: Record<string, unknown> = {},
) => {
  const product = await call(
    'POST',
    '/v1/products',
    { title: 'Producto de prueba', salePriceCents: 100_000, currency: 'ARS' },
    tenant,
  );
  expect(product.status).toBe(201);
  for (const cost of COSTS) {
    expect((await call('POST', `/v1/products/${product.json.id}/costs`, cost, tenant)).status).toBe(
      201,
    );
  }
  const sp = await call(
    'POST',
    '/v1/supplier-products',
    {
      supplierId,
      productId: product.json.id,
      supplierSku: `SKU-${Math.random().toString(36).slice(2, 8)}`,
      title: 'Oferta mayorista',
      wholesalePriceCents: 40_000,
      currency: 'ARS',
      priceSource: 'MANUAL',
      ...offer,
    },
    tenant,
  );
  expect(sp.status).toBe(201);
  return { productId: product.json.id as string, offerId: sp.json.id as string };
};

const calculate = (tenant: string, productId: string, offerId: string) =>
  call(
    'POST',
    `/v1/products/${productId}/profit-calculations`,
    { supplierProductId: offerId },
    tenant,
  );

const inStock = (tenant: string, offerId: string) =>
  call(
    'POST',
    `/v1/supplier-products/${offerId}/inventory`,
    { stockStatus: 'IN_STOCK', quantity: 10, source: 'SUPPLIER_REPORT' },
    tenant,
  );

beforeEach(() => {
  env = {
    DB: createTestD1(),
    APP_ENV: 'development',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    COMMERCIAL_ACTIONS_ENABLED: 'false',
  } as unknown as Env;
});

describe('Supplier Engine (API)', () => {
  it('proveedor sin verificar: arranca UNVERIFIED y no puede verificarse sin evidencia', async () => {
    const tenant = await createTenant('t1');
    const created = await call('POST', '/v1/suppliers', SUPPLIER, tenant);
    expect(created.status).toBe(201);
    expect(created.json.status).toBe('UNVERIFIED');
    const id = created.json.id as string;

    // Salto directo inválido
    const jump = await call(
      'POST',
      `/v1/suppliers/${id}/status`,
      { to: 'VERIFIED', reason: 'intento' },
      tenant,
    );
    expect(jump.status).toBe(409);

    await call(
      'POST',
      `/v1/suppliers/${id}/status`,
      { to: 'UNDER_REVIEW', reason: 'revisión' },
      tenant,
    );
    const noEvidence = await call(
      'POST',
      `/v1/suppliers/${id}/status`,
      { to: 'VERIFIED', reason: 'intento' },
      tenant,
    );
    expect(noEvidence.status).toBe(400);
    expect(noEvidence.json.error.details.missingEvidence).toEqual([
      'IDENTITY',
      'COMMERCIAL_TERMS',
      'DISPATCH_CAPABILITY',
    ]);
  });

  it('proveedor aprobado: con evidencia aceptada pasa a VERIFIED y queda historial', async () => {
    const tenant = await createTenant('t1');
    const { json } = await call('POST', '/v1/suppliers', SUPPLIER, tenant);
    const verified = await verifySupplier(tenant, json.id);
    expect(verified.status).toBe(200);
    expect(verified.json.status).toBe('VERIFIED');

    const detail = await call('GET', `/v1/suppliers/${json.id}`, undefined, tenant);
    expect(detail.json.missingEvidence).toEqual([]);
    expect(detail.json.history.map((h: Json) => h.toStatus)).toEqual(['VERIFIED', 'UNDER_REVIEW']);
    expect(detail.json.score.evidence).toBe(40);
    expect(detail.json.supplier.score).toBe(detail.json.score.total);
  });

  it('evidencia revisada no puede re-revisarse', async () => {
    const tenant = await createTenant('t1');
    const { json } = await call('POST', '/v1/suppliers', SUPPLIER, tenant);
    const ev = await call(
      'POST',
      `/v1/suppliers/${json.id}/evidence`,
      { category: 'IDENTITY', description: 'Constancia', reference: 'DOC-1' },
      tenant,
    );
    await call(
      'POST',
      `/v1/suppliers/${json.id}/evidence/${ev.json.id}/review`,
      { decision: 'REJECTED' },
      tenant,
    );
    const again = await call(
      'POST',
      `/v1/suppliers/${json.id}/evidence/${ev.json.id}/review`,
      { decision: 'ACCEPTED' },
      tenant,
    );
    expect(again.status).toBe(409);
  });

  it('cambiar condiciones comerciales de un VERIFIED lo devuelve a revisión', async () => {
    const tenant = await createTenant('t1');
    const { json } = await call('POST', '/v1/suppliers', SUPPLIER, tenant);
    await verifySupplier(tenant, json.id);
    const patched = await call(
      'PATCH',
      `/v1/suppliers/${json.id}`,
      { requiresPrepayment: false },
      tenant,
    );
    expect(patched.json.status).toBe('UNDER_REVIEW');
    const cosmetic = await call('PATCH', `/v1/suppliers/${json.id}`, { city: 'La Plata' }, tenant);
    expect(cosmetic.json.status).toBe('UNDER_REVIEW');
  });

  it('valida datos de entrada', async () => {
    const tenant = await createTenant('t1');
    const bad = await call(
      'POST',
      '/v1/suppliers',
      { ...SUPPLIER, countryCode: 'Argentina', taxId: '123' },
      tenant,
    );
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Profit Engine (API)', () => {
  it('producto rentable', async () => {
    const tenant = await createTenant('t1');
    const { json } = await call('POST', '/v1/suppliers', SUPPLIER, tenant);
    await verifySupplier(tenant, json.id);
    const { productId, offerId } = await setupProduct(tenant, json.id);
    await inStock(tenant, offerId);

    const r = await calculate(tenant, productId, offerId);
    expect(r.status).toBe(201);
    expect(r.json.status).toBe('PROFITABLE');
    expect(r.json.issues).toEqual([]);
    expect(r.json.breakdown).toMatchObject({
      netProfitCents: 29_900,
      marginBps: 2_990,
      minMarginBps: 2_000,
    });

    const list = await call('GET', '/v1/profit-calculations', undefined, tenant);
    expect(list.json.items).toHaveLength(1);
  });

  it('proveedor sin verificar ⇒ BLOCKED', async () => {
    const tenant = await createTenant('t1');
    const { json } = await call('POST', '/v1/suppliers', SUPPLIER, tenant);
    const { productId, offerId } = await setupProduct(tenant, json.id);
    await inStock(tenant, offerId);
    const r = await calculate(tenant, productId, offerId);
    expect(r.json.status).toBe('BLOCKED');
    expect(r.json.issues).toEqual(['SUPPLIER_NOT_VERIFIED']);
  });

  it('stock desconocido ⇒ BLOCKED (sin registro y con UNKNOWN)', async () => {
    const tenant = await createTenant('t1');
    const { json } = await call('POST', '/v1/suppliers', SUPPLIER, tenant);
    await verifySupplier(tenant, json.id);
    const { productId, offerId } = await setupProduct(tenant, json.id);

    expect((await calculate(tenant, productId, offerId)).json.issues).toEqual(['STOCK_UNKNOWN']);
    await call(
      'POST',
      `/v1/supplier-products/${offerId}/inventory`,
      { stockStatus: 'UNKNOWN', source: 'MANUAL' },
      tenant,
    );
    const r = await calculate(tenant, productId, offerId);
    expect(r.json.status).toBe('BLOCKED');
    expect(r.json.issues).toEqual(['STOCK_UNKNOWN']);
  });

  it('precio desactualizado ⇒ BLOCKED', async () => {
    const tenant = await createTenant('t1');
    const { json } = await call('POST', '/v1/suppliers', SUPPLIER, tenant);
    await verifySupplier(tenant, json.id);
    const { productId, offerId } = await setupProduct(tenant, json.id, {
      priceUpdatedAt: hoursAgo(100),
    });
    await inStock(tenant, offerId);
    const r = await calculate(tenant, productId, offerId);
    expect(r.json.status).toBe('BLOCKED');
    expect(r.json.issues).toEqual(['PRICE_STALE']);
  });

  it('margen negativo y margen inferior al mínimo', async () => {
    const tenant = await createTenant('t1');
    const { json } = await call('POST', '/v1/suppliers', SUPPLIER, tenant);
    await verifySupplier(tenant, json.id);
    const { productId, offerId } = await setupProduct(tenant, json.id);
    await inStock(tenant, offerId);

    await call(
      'PATCH',
      `/v1/supplier-products/${offerId}/price`,
      { wholesalePriceCents: 90_000, priceSource: 'MANUAL' },
      tenant,
    );
    const negative = await calculate(tenant, productId, offerId);
    expect(negative.json.status).toBe('NEGATIVE_MARGIN');
    expect(negative.json.breakdown.netProfitCents).toBeLessThan(0);

    await call(
      'PATCH',
      `/v1/supplier-products/${offerId}/price`,
      { wholesalePriceCents: 55_000, priceSource: 'MANUAL' },
      tenant,
    );
    const below = await calculate(tenant, productId, offerId);
    expect(below.json.status).toBe('BELOW_MIN_MARGIN');
    expect(below.json.breakdown.marginBps).toBe(1_490);
  });

  it('el umbral se configura por entorno', async () => {
    env = { ...env, MIN_NET_MARGIN_BPS: '1000' };
    const tenant = await createTenant('t1');
    const r = await call(
      'POST',
      '/v1/profit/simulate',
      { salePriceCents: 100_000, supplierCostCents: 55_000, components: COSTS },
      tenant,
    );
    expect(r.json.status).toBe('PROFITABLE');
    expect(r.json.minMarginBps).toBe(1_000);
  });

  it('no calcula con una oferta no vinculada al producto', async () => {
    const tenant = await createTenant('t1');
    const { json } = await call('POST', '/v1/suppliers', SUPPLIER, tenant);
    const { offerId } = await setupProduct(tenant, json.id);
    const other = await call(
      'POST',
      '/v1/products',
      { title: 'Otro', salePriceCents: 1_000, currency: 'ARS' },
      tenant,
    );
    expect((await calculate(tenant, other.json.id, offerId)).status).toBe(409);
  });
});

describe('Financial Guard (API)', () => {
  const request = {
    availableFundsCents: 0,
    fundsSource: 'MANUAL',
    totalCostsCents: 50_000,
    expectedSettlementCents: 80_000,
    channelSettlementDate: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    supplierPaymentDueDate: new Date(Date.now() + 86_400_000).toISOString(),
    returnRiskBps: 500,
    financing: null,
  };

  it('operación sin financiación ⇒ BLOCKED y auditada', async () => {
    const tenant = await createTenant('t1');
    const r = await call(
      'POST',
      '/v1/financial-guard/evaluate',
      { ...request, fundsAsOf: hoursAgo(1) },
      tenant,
    );
    expect(r.status).toBe(200);
    expect(r.json.decision).toBe('BLOCKED');
    expect(r.json.issues).toEqual(['PREPAYMENT_WITHOUT_FUNDS']);
  });

  it('rechaza solicitudes sin datos completos (no se asumen valores)', async () => {
    const tenant = await createTenant('t1');
    const { fundsSource: _omit, ...incomplete } = request;
    const r = await call(
      'POST',
      '/v1/financial-guard/evaluate',
      { ...incomplete, fundsAsOf: hoursAgo(1) },
      tenant,
    );
    expect(r.status).toBe(400);
  });
});

describe('aislamiento y acceso', () => {
  it('un tenant no ve datos de otro', async () => {
    const a = await createTenant('a');
    const b = await createTenant('b');
    const { json } = await call('POST', '/v1/suppliers', SUPPLIER, a);
    expect((await call('GET', `/v1/suppliers/${json.id}`, undefined, b)).status).toBe(404);
    expect((await call('GET', '/v1/suppliers', undefined, b)).json.items).toEqual([]);
  });

  it('sin header de tenant ⇒ 401; fuera de development ⇒ 401', async () => {
    expect((await call('GET', '/v1/suppliers')).status).toBe(401);
    const tenant = await createTenant('t1');
    env = { ...env, APP_ENV: 'production' };
    expect((await call('GET', '/v1/suppliers', undefined, tenant)).status).toBe(401);
  });
});

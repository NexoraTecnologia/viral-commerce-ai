import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app';
import type { Env } from '../../apps/api/src/env';
import { createTestD1 } from '../support/node-d1';

/**
 * Integración Discovery + Content + Product Scoring + Risk Guardian:
 * HTTP → reglas → SQLite real. Sin red ni fuentes externas. Montos sintéticos.
 */
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
  const json: Json = await res.json();
  return { status: res.status, json };
};

const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => ago(d * 24);

const tenantOf = async (slug: string) =>
  (await call('POST', '/v1/tenants', { name: slug, slug })).json.id as string;

const source = async (t: string, kind: string, name = kind) =>
  (await call('POST', '/v1/discovery/sources', { name, kind }, t)).json;

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

const COSTS = [
  { kind: 'SHIPPING', name: 'Envío', fixedCents: 5_000 },
  { kind: 'CHANNEL_COMMISSION', name: 'Comisión', rateBps: 1_300 },
  { kind: 'PAYMENT_PROCESSING', name: 'Cobro', rateBps: 400, fixedCents: 100 },
  { kind: 'TAX', name: 'Impuesto', rateBps: 300 },
  { kind: 'WITHHOLDING', name: 'Retención', rateBps: 200 },
  { kind: 'RETURN_RESERVE', name: 'Reserva', rateBps: 300 },
];

const verify = async (t: string, supplierId: string) => {
  await call(
    'POST',
    `/v1/suppliers/${supplierId}/status`,
    { to: 'UNDER_REVIEW', reason: 'revisión' },
    t,
  );
  for (const category of ['IDENTITY', 'COMMERCIAL_TERMS', 'DISPATCH_CAPABILITY']) {
    const ev = await call(
      'POST',
      `/v1/suppliers/${supplierId}/evidence`,
      { category, description: `Doc ${category}`, reference: `REF-${category}` },
      t,
    );
    await call(
      'POST',
      `/v1/suppliers/${supplierId}/evidence/${ev.json.id}/review`,
      { decision: 'ACCEPTED' },
      t,
    );
  }
  const r = await call(
    'POST',
    `/v1/suppliers/${supplierId}/status`,
    { to: 'VERIFIED', reason: 'Evidencia completa' },
    t,
  );
  expect(r.json.status).toBe('VERIFIED');
};

/** Producto propio + costos + proveedor + oferta con stock: base para Risk Guardian. */
const commercialSetup = async (t: string) => {
  const supplier = (await call('POST', '/v1/suppliers', SUPPLIER, t)).json;
  const product = (
    await call(
      'POST',
      '/v1/products',
      { title: 'Organizador de cocina', salePriceCents: 100_000, currency: 'ARS' },
      t,
    )
  ).json;
  for (const c of COSTS) await call('POST', `/v1/products/${product.id}/costs`, c, t);
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
  return {
    supplierId: supplier.id as string,
    productId: product.id as string,
    offerId: offer.id as string,
  };
};

/** Señales de mercado reales registradas a mano: demanda en suba y 2 competidores. */
const marketData = async (t: string, discoveredId: string, sourceId: string) => {
  for (const [i, v] of [20, 35, 55, 80].entries()) {
    const r = await call(
      'POST',
      `/v1/discovery/products/${discoveredId}/demand`,
      {
        metric: 'SEARCH_INTEREST',
        value: v,
        unit: 'índice 0-100',
        sourceId,
        sourceRef: `planilla-semana-${i}`,
        observedAt: daysAgo((3 - i) * 7 + 1),
      },
      t,
    );
    expect(r.status).toBe(201);
  }
  for (const name of ['Tienda A', 'Tienda B']) {
    const comp = (
      await call('POST', '/v1/discovery/competitors', { name, channel: 'ECOMMERCE' }, t)
    ).json;
    await call(
      'POST',
      `/v1/discovery/products/${discoveredId}/prices`,
      {
        priceCents: 110_000,
        currency: 'ARS',
        competitorId: comp.id,
        sourceId,
        sourceRef: `https://example.com/${name}`,
        observedAt: daysAgo(2),
      },
      t,
    );
  }
};

beforeEach(() => {
  env = {
    DB: createTestD1(),
    JOBS_QUEUE: { sendBatch: () => Promise.resolve() },
    APP_ENV: 'development',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    COMMERCIAL_ACTIONS_ENABLED: 'false',
  } as unknown as Env;
});

describe('fuentes y adaptadores', () => {
  it('Google Trends, fuentes públicas y APIs comerciales quedan NOT_CONFIGURED y no generan datos', async () => {
    const t = await tenantOf('t1');
    for (const kind of ['GOOGLE_TRENDS', 'PUBLIC_SOURCE', 'COMMERCIAL_API']) {
      const s = await source(t, kind);
      expect(s.status).toBe('NOT_CONFIGURED');
      const sync = await call('POST', `/v1/discovery/sources/${s.id}/sync`, undefined, t);
      expect(sync.json).toMatchObject({ status: 'NOT_CONFIGURED', created: 0 });
    }
    expect((await call('GET', '/v1/discovery/products', undefined, t)).json.items).toEqual([]);
    expect((await source(t, 'MANUAL')).status).toBe('CONFIGURED');
  });

  it('el catálogo de proveedores detecta productos desde las ofertas registradas (sin duplicar)', async () => {
    const t = await tenantOf('t1');
    const { offerId, productId } = await commercialSetup(t);
    const s = await source(t, 'SUPPLIER_CATALOG', 'Catálogo propio');
    expect(s.status).toBe('CONFIGURED');
    const first = await call('POST', `/v1/discovery/sources/${s.id}/sync`, undefined, t);
    expect(first.json).toMatchObject({ status: 'CONFIGURED', created: 1 });
    const again = await call('POST', `/v1/discovery/sources/${s.id}/sync`, undefined, t);
    expect(again.json.created).toBe(0);
    const [p] = (await call('GET', '/v1/discovery/products', undefined, t)).json.items;
    expect(p).toMatchObject({
      supplierProductId: offerId,
      productId,
      sourceRef: 'supplier-sku:ORG-1',
    });
  });
});

describe('registro de productos y datos', () => {
  it('clasifica por palabras clave y exige fuente y fecha válidas en cada dato', async () => {
    const t = await tenantOf('t1');
    const manual = await source(t, 'MANUAL');
    const cat = (
      await call(
        'POST',
        '/v1/discovery/categories',
        { name: 'Hogar', keywords: ['cocina', 'organizador'] },
        t,
      )
    ).json;
    const created = await call(
      'POST',
      '/v1/discovery/products',
      {
        title: 'Organizador de cocina giratorio',
        sourceId: manual.id,
        sourceRef: 'feria-2026',
        observedAt: ago(1),
      },
      t,
    );
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      categoryId: cat.id,
      categorySource: 'RULE',
      status: 'RESEARCHING',
    });

    const id = created.json.id;
    const future = await call(
      'POST',
      `/v1/discovery/products/${id}/demand`,
      {
        metric: 'SEARCH_INTEREST',
        value: 50,
        unit: 'índice',
        sourceId: manual.id,
        sourceRef: 'x',
        observedAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      t,
    );
    expect(future.status).toBe(400);
    const noSource = await call(
      'POST',
      `/v1/discovery/products/${id}/demand`,
      { metric: 'SEARCH_INTEREST', value: 50, unit: 'índice', observedAt: ago(1) },
      t,
    );
    expect(noSource.status).toBe(400);

    const other = await tenantOf('t2');
    const foreign = await source(other, 'MANUAL');
    const crossTenant = await call(
      'POST',
      `/v1/discovery/products/${id}/demand`,
      {
        metric: 'SEARCH_INTEREST',
        value: 50,
        unit: 'índice',
        sourceId: foreign.id,
        sourceRef: 'x',
        observedAt: ago(1),
      },
      t,
    );
    expect(crossTenant.status).toBe(404);
  });

  it('una imagen autorizada exige referencia de la autorización', async () => {
    const t = await tenantOf('t1');
    const manual = await source(t, 'MANUAL');
    const p = (
      await call(
        'POST',
        '/v1/discovery/products',
        { title: 'Lámpara', sourceId: manual.id, sourceRef: 'r', observedAt: ago(1) },
        t,
      )
    ).json;
    const bad = await call(
      'POST',
      `/v1/discovery/products/${p.id}/images`,
      { url: 'https://example.com/a.jpg', authorization: 'LICENSED' },
      t,
    );
    expect(bad.status).toBe(400);
  });
});

describe('puntuación, tendencia y saturación', () => {
  it('sin datos no inventa demanda: puntaje 0, confianza 0, tendencia insuficiente', async () => {
    const t = await tenantOf('t1');
    const manual = await source(t, 'MANUAL');
    const p = (
      await call(
        'POST',
        '/v1/discovery/products',
        { title: 'Producto sin datos', sourceId: manual.id, sourceRef: 'r', observedAt: ago(1) },
        t,
      )
    ).json;
    const a = await call('POST', `/v1/discovery/products/${p.id}/analyze`, undefined, t);
    expect(a.status).toBe(201);
    expect(a.json.score).toMatchObject({ total: 0, confidence: 0 });
    expect(a.json.signals).toMatchObject({
      trend: 'INSUFFICIENT_DATA',
      opportunity: false,
      saturated: false,
    });
    expect(a.json.risk.passed).toBe(false);
  });

  it('detecta un producto saturado con los competidores observados', async () => {
    const t = await tenantOf('t1');
    const manual = await source(t, 'MANUAL');
    const p = (
      await call(
        'POST',
        '/v1/discovery/products',
        { title: 'Funda de celular', sourceId: manual.id, sourceRef: 'r', observedAt: ago(1) },
        t,
      )
    ).json;
    for (let i = 0; i < 12; i++) {
      const comp = (
        await call(
          'POST',
          '/v1/discovery/competitors',
          { name: `Vendedor ${i}`, channel: 'MARKETPLACE' },
          t,
        )
      ).json;
      await call(
        'POST',
        `/v1/discovery/products/${p.id}/prices`,
        {
          priceCents: 5_000,
          currency: 'ARS',
          competitorId: comp.id,
          sourceId: manual.id,
          sourceRef: `listado-${i}`,
          observedAt: daysAgo(3),
        },
        t,
      );
    }
    const a = await call('POST', `/v1/discovery/products/${p.id}/analyze`, undefined, t);
    expect(a.json.signals).toMatchObject({
      saturated: true,
      competitorCount: 12,
      opportunity: false,
    });
  });
});

describe('Risk Guardian', () => {
  it('un puntaje alto NO evita los controles: proveedor sin verificar bloquea la promoción', async () => {
    const t = await tenantOf('t1');
    const { supplierId, productId, offerId } = await commercialSetup(t);
    const manual = await source(t, 'MANUAL');
    const p = (
      await call(
        'POST',
        '/v1/discovery/products',
        {
          title: 'Organizador de cocina de bambú',
          sourceId: manual.id,
          sourceRef: 'r',
          observedAt: ago(1),
        },
        t,
      )
    ).json;
    await call(
      'PATCH',
      `/v1/discovery/products/${p.id}`,
      { productId, supplierProductId: offerId },
      t,
    );
    await marketData(t, p.id, manual.id);

    const a = await call('POST', `/v1/discovery/products/${p.id}/analyze`, undefined, t);
    expect(a.json.score.total).toBeGreaterThanOrEqual(65);
    expect(a.json.signals.opportunity).toBe(true);
    expect(a.json.risk).toMatchObject({ passed: false, blockers: ['SUPPLIER_VERIFIED'] });

    const blocked = await call('POST', `/v1/discovery/products/${p.id}/promote`, undefined, t);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.details.blockers).toEqual(['SUPPLIER_VERIFIED']);

    await verify(t, supplierId);
    const promoted = await call('POST', `/v1/discovery/products/${p.id}/promote`, undefined, t);
    expect(promoted.status).toBe(200);
    expect(promoted.json.product.status).toBe('CANDIDATE');
    expect(promoted.json.analysis.risk.passed).toBe(true);
  });

  it('sin producto ni oferta vinculados, Risk Guardian bloquea', async () => {
    const t = await tenantOf('t1');
    const manual = await source(t, 'MANUAL');
    const p = (
      await call(
        'POST',
        '/v1/discovery/products',
        { title: 'Suelto', sourceId: manual.id, sourceRef: 'r', observedAt: ago(1) },
        t,
      )
    ).json;
    const r = await call('POST', `/v1/discovery/products/${p.id}/promote`, undefined, t);
    expect(r.status).toBe(409);
    expect(r.json.error.details.blockers).toEqual(
      expect.arrayContaining(['SUPPLIER_LINKED', 'PRODUCT_LINKED']),
    );
  });
});

describe('estados y radar', () => {
  it('descartar, reabrir y radar sin descartados', async () => {
    const t = await tenantOf('t1');
    const manual = await source(t, 'MANUAL');
    const a = (
      await call(
        'POST',
        '/v1/discovery/products',
        { title: 'Producto A', sourceId: manual.id, sourceRef: 'r', observedAt: ago(1) },
        t,
      )
    ).json;
    const b = (
      await call(
        'POST',
        '/v1/discovery/products',
        { title: 'Producto B', sourceId: manual.id, sourceRef: 'r', observedAt: ago(1) },
        t,
      )
    ).json;
    const d = await call(
      'POST',
      `/v1/discovery/products/${a.id}/discard`,
      { reason: 'Margen insuficiente' },
      t,
    );
    expect(d.json).toMatchObject({ status: 'DISCARDED', discardReason: 'Margen insuficiente' });
    expect(
      (await call('GET', '/v1/discovery/radar', undefined, t)).json.items.map((x: Json) => x.id),
    ).toEqual([b.id]);
    expect(
      (await call('GET', '/v1/discovery/products?status=DISCARDED', undefined, t)).json.items,
    ).toHaveLength(1);
    const r = await call('POST', `/v1/discovery/products/${a.id}/reopen`, undefined, t);
    expect(r.json.status).toBe('RESEARCHING');
  });
});

describe('Content Engine (API)', () => {
  it('solo genera para candidatos, con hechos verificados e imágenes autorizadas', async () => {
    const t = await tenantOf('t1');
    const { supplierId, productId, offerId } = await commercialSetup(t);
    await verify(t, supplierId);
    const manual = await source(t, 'MANUAL');
    await call('POST', '/v1/discovery/categories', { name: 'Hogar', keywords: ['cocina'] }, t);
    const p = (
      await call(
        'POST',
        '/v1/discovery/products',
        {
          title: 'Organizador de cocina de bambú',
          sourceId: manual.id,
          sourceRef: 'r',
          observedAt: ago(1),
        },
        t,
      )
    ).json;
    await call(
      'PATCH',
      `/v1/discovery/products/${p.id}`,
      { productId, supplierProductId: offerId },
      t,
    );

    const attr = (name: string, value: string, verification: string) =>
      call(
        'POST',
        `/v1/discovery/products/${p.id}/attributes`,
        {
          name,
          value,
          verification,
          sourceId: manual.id,
          sourceRef: 'ficha-proveedor',
          observedAt: ago(1),
        },
        t,
      );
    await attr('Material', 'Bambú', 'VERIFIED');
    await attr('Capacidad', '10 kg', 'UNVERIFIED');
    await call(
      'POST',
      `/v1/discovery/products/${p.id}/images`,
      {
        url: 'https://example.com/propia.jpg',
        authorization: 'OWN_PHOTO',
        authorizationRef: 'Foto propia 2026-11',
      },
      t,
    );
    await call(
      'POST',
      `/v1/discovery/products/${p.id}/images`,
      { url: 'https://example.com/ajena.jpg', authorization: 'NONE' },
      t,
    );

    expect(
      (await call('POST', `/v1/discovery/products/${p.id}/content`, undefined, t)).status,
    ).toBe(409);
    expect(
      (await call('POST', `/v1/discovery/products/${p.id}/promote`, undefined, t)).status,
    ).toBe(200);

    const c1 = await call('POST', `/v1/discovery/products/${p.id}/content`, undefined, t);
    expect(c1.status).toBe(201);
    expect(c1.json).toMatchObject({
      version: 1,
      templateVersion: 'v1',
      compliance: { ok: true, excludedAttributes: 1, excludedImages: 1 },
    });
    expect(c1.json.content.features).toEqual(['Material: Bambú']);
    expect(c1.json.content.images).toEqual(['https://example.com/propia.jpg']);
    expect(c1.json.content.seoTitle).toBe('Organizador de cocina de bambú | Hogar');
    expect(c1.json.content.benefits).toContain('Envío con número de seguimiento.');
    expect(JSON.stringify(c1.json.content)).not.toContain('10 kg');
    expect(c1.json.content.whatsapp).toContain('Precio:');

    const c2 = await call('POST', `/v1/discovery/products/${p.id}/content`, undefined, t);
    expect(c2.json.version).toBe(2);
    expect((await call('GET', '/v1/discovery/content', undefined, t)).json.items).toHaveLength(2);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '@vc/database';
import { parseApiConfig } from '@vc/shared';
import { createApp } from '../../apps/api/src/app';
import type { Env } from '../../apps/api/src/env';
import { reevaluateBlocked, scanSupplierTimeouts } from '../../apps/api/src/modules/orders/service';
import { createTestD1 } from '../support/node-d1';

/**
 * Integración Order + Fulfillment: HTTP → motor → SQLite real. Sin red ni
 * terceros. Montos sintéticos de prueba; las "evidencias" son referencias de test.
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
  return { status: res.status, json: (await res.json()) as Json };
};

const nowIso = () => new Date().toISOString();
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const tenantOf = async (slug: string) =>
  (await call('POST', '/v1/tenants', { name: slug, slug })).json.id as string;

const SUPPLIER = {
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

const verifiedSupplier = async (t: string, name: string) => {
  const s = (await call('POST', '/v1/suppliers', { ...SUPPLIER, legalName: name }, t)).json;
  await call('POST', `/v1/suppliers/${s.id}/status`, { to: 'UNDER_REVIEW', reason: 'revisión' }, t);
  for (const category of ['IDENTITY', 'COMMERCIAL_TERMS', 'DISPATCH_CAPABILITY']) {
    const ev = await call(
      'POST',
      `/v1/suppliers/${s.id}/evidence`,
      { category, description: `Doc ${category}`, reference: `REF-${category}` },
      t,
    );
    await call(
      'POST',
      `/v1/suppliers/${s.id}/evidence/${ev.json.id}/review`,
      { decision: 'ACCEPTED' },
      t,
    );
  }
  await call(
    'POST',
    `/v1/suppliers/${s.id}/status`,
    { to: 'VERIFIED', reason: 'Evidencia completa' },
    t,
  );
  return s.id as string;
};

const offer = async (
  t: string,
  supplierId: string,
  productId: string,
  wholesale: number,
  stock: { status: string; quantity: number },
) => {
  const o = (
    await call(
      'POST',
      '/v1/supplier-products',
      {
        supplierId,
        productId,
        supplierSku: `SKU-${supplierId.slice(0, 4)}`,
        title: 'Oferta',
        wholesalePriceCents: wholesale,
        currency: 'ARS',
        priceSource: 'SUPPLIER_REPORT',
      },
      t,
    )
  ).json;
  await call(
    'POST',
    `/v1/supplier-products/${o.id}/inventory`,
    { stockStatus: stock.status, quantity: stock.quantity, source: 'SUPPLIER_REPORT' },
    t,
  );
  return o.id as string;
};

/** Producto con costos, un proveedor verificado con stock y opcionalmente fondos. */
const setup = async (t: string, opts: { stock?: number; funds?: number | null } = {}) => {
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
    { kind: 'CHANNEL_COMMISSION', name: 'Comisión', rateBps: 1300 },
    t,
  );
  await call(
    'POST',
    `/v1/products/${product.id}/costs`,
    { kind: 'SHIPPING', name: 'Envío', fixedCents: 5_000 },
    t,
  );
  const supplierA = await verifiedSupplier(t, 'Proveedor A SRL');
  const offerA = await offer(t, supplierA, product.id, 40_000, {
    status: 'IN_STOCK',
    quantity: opts.stock ?? 10,
  });
  if (opts.funds !== null) {
    await call(
      'POST',
      '/v1/finance/funds',
      {
        availableCents: opts.funds ?? 500_000,
        currency: 'ARS',
        asOf: ago(1),
        source: 'MANUAL',
        sourceRef: 'Extracto bancario de prueba',
      },
      t,
    );
  }
  return { productId: product.id as string, supplierA, offerA };
};

const newOrder = async (t: string, productId: string, quantity = 1) =>
  call(
    'POST',
    '/v1/orders',
    {
      buyerRef: 'comprador-test',
      currency: 'ARS',
      items: [{ productId, quantity, unitPriceCents: 100_000 }],
    },
    t,
  );

const pay = (
  t: string,
  id: string,
  status: 'APPROVED' | 'REJECTED' = 'APPROVED',
  amount = 100_000,
  extId = 'MP-1001',
) =>
  call(
    'POST',
    `/v1/orders/${id}/payments`,
    {
      provider: 'Mercado Pago',
      externalPaymentId: extId,
      status,
      amountCents: amount,
      currency: 'ARS',
      evidenceSource: 'PAYMENT_PROVIDER_REPORT',
      evidenceRef: `Reporte de prueba ${extId}`,
      observedAt: nowIso(),
    },
    t,
  );

const rtFor = (t: string, now = new Date()) => ({
  db: createDb(env.DB),
  tenantId: t,
  config: parseApiConfig({ ...env }),
  now,
});

beforeEach(() => {
  env = {
    DB: createTestD1(),
    JOBS_QUEUE: { sendBatch: () => Promise.resolve() },
    APP_ENV: 'development',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    COMMERCIAL_ACTIONS_ENABLED: 'false',
  } as unknown as Env;
});

describe('recepción y pago', () => {
  it('nuevo pedido queda esperando pago; pago parcial o sin evidencia no confirma', async () => {
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t);
    const o = await newOrder(t, productId);
    expect(o.status).toBe(201);
    expect(o.json.order).toMatchObject({
      state: 'PAYMENT_PENDING',
      number: 1001,
      totalCents: 100_000,
    });
    expect(o.json.buyerStatus).toContain('esperando la confirmación del pago');

    const partial = await pay(t, o.json.order.id, 'APPROVED', 50_000, 'MP-PARCIAL');
    expect(partial.json.order.state).toBe('PAYMENT_PENDING');
    const noEvidence = await call(
      'POST',
      `/v1/orders/${o.json.order.id}/payments`,
      {
        provider: 'Mercado Pago',
        externalPaymentId: 'MP-X',
        status: 'APPROVED',
        amountCents: 100_000,
        currency: 'ARS',
        evidenceSource: 'MANUAL_EVIDENCE',
        evidenceRef: '',
        observedAt: nowIso(),
      },
      t,
    );
    expect(noEvidence.status).toBe(400);
    const future = await call(
      'POST',
      `/v1/orders/${o.json.order.id}/payments`,
      {
        provider: 'Mercado Pago',
        externalPaymentId: 'MP-F',
        status: 'APPROVED',
        amountCents: 100_000,
        currency: 'ARS',
        evidenceSource: 'MANUAL_EVIDENCE',
        evidenceRef: 'comprobante',
        observedAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      t,
    );
    expect(future.status).toBe(400);
  });

  it('pago rechazado por el canal → CANCELLED sin pedir nada al proveedor', async () => {
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t);
    const o = await newOrder(t, productId);
    const r = await pay(t, o.json.order.id, 'REJECTED');
    expect(r.json.order.state).toBe('CANCELLED');
    expect(r.json.supplierOrders).toEqual([]);
  });

  it('el mismo evento de pago no se registra dos veces (idempotencia)', async () => {
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t);
    const o = await newOrder(t, productId);
    await pay(t, o.json.order.id);
    const again = await pay(t, o.json.order.id);
    expect(again.json.payments).toHaveLength(1);
    expect(again.json.ledger.filter((l: Json) => l.type === 'SALE')).toHaveLength(1);
  });

  it('productos de otro tenant o moneda distinta se rechazan', async () => {
    const a = await tenantOf('tienda-a');
    const b = await tenantOf('tienda-b');
    const { productId } = await setup(a);
    expect((await newOrder(b, productId)).status).toBe(404);
    const usd = await call(
      'POST',
      '/v1/orders',
      { buyerRef: 'x1', currency: 'USD', items: [{ productId, quantity: 1, unitPriceCents: 100 }] },
      a,
    );
    expect(usd.status).toBe(400);
  });
});

describe('stock, proveedor y fondos', () => {
  it('pagado sin dato de fondos → BLOCKED_CASHFLOW; al registrar saldo se reevalúa y aprueba', async () => {
    const t = await tenantOf('tienda-a');
    const { productId, supplierA } = await setup(t, { funds: null });
    const o = await newOrder(t, productId);
    const paid = await pay(t, o.json.order.id);
    expect(paid.json.order.state).toBe('BLOCKED_CASHFLOW');
    expect(paid.json.financialCheck.issues).toContain('NO_FUNDS_DATA');
    expect(paid.json.supplierOrders[0]).toMatchObject({
      supplierId: supplierA,
      status: 'SELECTED',
      costCents: 40_000,
    });
    expect(paid.json.buyerStatus).toContain('en revisión');

    const funds = await call(
      'POST',
      '/v1/finance/funds',
      {
        availableCents: 300_000,
        currency: 'ARS',
        asOf: ago(1),
        source: 'MANUAL',
        sourceRef: 'Extracto',
      },
      t,
    );
    expect(funds.json.reevaluated).toEqual({ evaluated: 1, changed: 1 });
    const d = (await call('GET', `/v1/orders/${o.json.order.id}`, undefined, t)).json;
    expect(d.order.state).toBe('FINANCIAL_APPROVED');
  });

  it('fondos insuficientes: el proveedor cobra antes y no alcanza → nunca se ordena', async () => {
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t, { funds: 30_000 });
    const o = await newOrder(t, productId);
    const r = await pay(t, o.json.order.id);
    expect(r.json.order.state).toBe('BLOCKED_CASHFLOW');
    expect(r.json.financialCheck.issues).toContain('PREPAYMENT_WITHOUT_FUNDS');
    const dispatch = await call(
      'POST',
      `/v1/orders/${o.json.order.id}/dispatch-request`,
      { requestRef: 'OC-1' },
      t,
    );
    expect(dispatch.status).toBe(409);
  });

  it('los fondos comprometidos por otro pedido aprobado se descuentan', async () => {
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t, { funds: 100_000 });
    const first = await newOrder(t, productId);
    expect((await pay(t, first.json.order.id, 'APPROVED', 100_000, 'MP-1')).json.order.state).toBe(
      'FINANCIAL_APPROVED',
    );
    const second = await newOrder(t, productId);
    const r = await pay(t, second.json.order.id, 'APPROVED', 100_000, 'MP-2');
    expect(r.json.order.state).toBe('BLOCKED_CASHFLOW');
    expect(r.json.financialCheck.committedCents).toBeGreaterThan(0);
  });

  it('sin stock → BLOCKED_NO_STOCK; con un control nuevo de stock el agente lo reevalúa', async () => {
    const t = await tenantOf('tienda-a');
    const { productId, offerA } = await setup(t, { stock: 0 });
    await call(
      'POST',
      `/v1/supplier-products/${offerA}/inventory`,
      { stockStatus: 'OUT_OF_STOCK', quantity: 0, source: 'SUPPLIER_REPORT' },
      t,
    );
    const o = await newOrder(t, productId);
    const r = await pay(t, o.json.order.id);
    expect(r.json.order.state).toBe('BLOCKED_NO_STOCK');
    await call(
      'POST',
      `/v1/supplier-products/${offerA}/inventory`,
      { stockStatus: 'IN_STOCK', quantity: 4, source: 'SUPPLIER_REPORT' },
      t,
    );
    expect(await reevaluateBlocked(rtFor(t))).toMatchObject({ changed: 1 });
    const d = (await call('GET', `/v1/orders/${o.json.order.id}`, undefined, t)).json;
    expect(d.order.state).toBe('FINANCIAL_APPROVED');
  });

  it('cantidad pedida mayor al stock confirmado → BLOCKED_NO_STOCK', async () => {
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t, { stock: 2 });
    const o = await newOrder(t, productId, 3);
    const r = await pay(t, o.json.order.id, 'APPROVED', 300_000);
    expect(r.json.order.state).toBe('BLOCKED_NO_STOCK');
  });

  it('proveedor sin verificar no se selecciona → BLOCKED_SUPPLIER', async () => {
    const t = await tenantOf('tienda-a');
    const product = (
      await call(
        'POST',
        '/v1/products',
        { title: 'X producto', salePriceCents: 100_000, currency: 'ARS' },
        t,
      )
    ).json;
    const s = (
      await call('POST', '/v1/suppliers', { ...SUPPLIER, legalName: 'Sin verificar SA' }, t)
    ).json;
    await offer(t, s.id, product.id, 40_000, { status: 'IN_STOCK', quantity: 9 });
    const o = await newOrder(t, product.id);
    const r = await pay(t, o.json.order.id);
    expect(r.json.order.state).toBe('BLOCKED_SUPPLIER');
  });

  it('elige el proveedor verificado más barato con stock', async () => {
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t);
    const supplierB = await verifiedSupplier(t, 'Proveedor B SRL');
    await offer(t, supplierB, productId, 35_000, { status: 'IN_STOCK', quantity: 3 });
    const o = await newOrder(t, productId);
    const r = await pay(t, o.json.order.id);
    expect(r.json.supplierOrders[0]).toMatchObject({ supplierId: supplierB, costCents: 35_000 });
  });
});

describe('despacho y entrega', () => {
  it('con el interruptor comercial apagado la solicitud al proveedor se bloquea y queda registrada', async () => {
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t);
    const o = await newOrder(t, productId);
    await pay(t, o.json.order.id);
    const r = await call(
      'POST',
      `/v1/orders/${o.json.order.id}/dispatch-request`,
      { requestRef: 'OC-1' },
      t,
    );
    expect(r.status).toBe(403);
    const d = (await call('GET', `/v1/orders/${o.json.order.id}`, undefined, t)).json;
    expect(d.events.some((e: Json) => e.type === 'DISPATCH_BLOCKED')).toBe(true);
    expect(d.supplierOrders[0].status).toBe('SELECTED');
  });

  it('compra correcta completa hasta SETTLED con conciliación (interruptor habilitado, sin terceros)', async () => {
    env = { ...env, COMMERCIAL_ACTIONS_ENABLED: 'true' };
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t);
    const o = await newOrder(t, productId);
    const id = o.json.order.id;
    await pay(t, id);
    const req = await call(
      'POST',
      `/v1/orders/${id}/dispatch-request`,
      { requestRef: 'OC-0001 enviada por email' },
      t,
    );
    expect(req.json.supplierOrders[0].status).toBe('REQUESTED');

    // No se puede informar despacho antes de la aceptación del proveedor.
    const early = await call(
      'POST',
      `/v1/orders/${id}/shipments`,
      {
        carrier: 'Andreani',
        trackingNumber: 'AR123456',
        confirmationSource: 'SUPPLIER_DOCUMENT',
        confirmationRef: 'remito 1',
        shippedAt: nowIso(),
      },
      t,
    );
    expect(early.status).toBe(409);

    const acc = await call(
      'POST',
      `/v1/orders/${id}/supplier-response`,
      { decision: 'ACCEPTED', confirmationRef: 'Mail de confirmación del proveedor' },
      t,
    );
    expect(acc.json.order.state).toBe('SUPPLIER_ORDER_ACCEPTED');

    const noRef = await call(
      'POST',
      `/v1/orders/${id}/shipments`,
      {
        carrier: 'Andreani',
        trackingNumber: 'AR123456',
        confirmationSource: 'SUPPLIER_DOCUMENT',
        shippedAt: nowIso(),
      },
      t,
    );
    expect(noRef.status).toBe(400);
    const shipped = await call(
      'POST',
      `/v1/orders/${id}/shipments`,
      {
        carrier: 'Andreani',
        trackingNumber: 'AR123456',
        confirmationSource: 'CARRIER_TRACKING',
        confirmationRef: 'Evento de admisión en el sitio del transportista',
        shippedAt: nowIso(),
        estimatedDeliveryAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      },
      t,
    );
    expect(shipped.json.order.state).toBe('SHIPPED');
    expect(shipped.json.buyerStatus).toContain('Andreani');
    expect(shipped.json.buyerStatus).toContain('AR123456');

    const delivered = await call(
      'POST',
      `/v1/orders/${id}/shipment-events`,
      {
        status: 'DELIVERED',
        evidenceRef: 'Evento de entrega del transportista',
        occurredAt: nowIso(),
      },
      t,
    );
    expect(delivered.json.order.state).toBe('DELIVERED');
    expect(delivered.json.reconciliation.status).toBe('PENDING_DATA');
    expect(delivered.json.reconciliation.missing).toContain('SUPPLIER_COST');

    for (const [type, amount, ref] of [
      ['CHANNEL_FEE', 13_000, 'Liquidación del canal #55'],
      ['SHIPPING_COST', 5_000, 'Factura del transportista'],
      ['SUPPLIER_COST', 40_000, 'Factura del proveedor A-0001'],
    ] as const) {
      await call(
        'POST',
        `/v1/orders/${id}/ledger`,
        { type, amountCents: amount, currency: 'ARS', sourceRef: ref, occurredAt: nowIso() },
        t,
      );
    }
    const settled = (await call('GET', `/v1/orders/${id}`, undefined, t)).json;
    expect(settled.order.state).toBe('SETTLED');
    expect(settled.reconciliation).toMatchObject({
      status: 'MATCHED',
      netCents: 42_000,
      expectedNetCents: 42_000,
      differenceCents: 0,
    });
    const types = settled.events.map((e: Json) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'ORDER_RECEIVED',
        'PAYMENT_RECORDED',
        'DISPATCH_REQUESTED',
        'SUPPLIER_ACCEPTED',
        'SHIPMENT_REGISTERED',
        'SHIPMENT_DELIVERED',
        'LEDGER_ENTRY',
      ]),
    );
    const path = settled.events
      .filter((e: Json) => e.type === 'STATE_CHANGED')
      .map((e: Json) => e.toState);
    expect(path).toEqual([
      'PAYMENT_PENDING',
      'PAYMENT_CONFIRMED',
      'SUPPLIER_STOCK_VERIFIED',
      'FINANCIAL_APPROVED',
      'SUPPLIER_ORDER_ACCEPTED',
      'SHIPPED',
      'DELIVERED',
      'SETTLED',
    ]);
    const raw = await env.DB.prepare('SELECT reserved_funds_cents FROM orders').first();
    expect(raw).toEqual({ reserved_funds_cents: 0 });
  });

  it('conciliación con diferencia → MANUAL_REVIEW (no se cierra)', async () => {
    env = { ...env, COMMERCIAL_ACTIONS_ENABLED: 'true' };
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t);
    const { json } = await newOrder(t, productId);
    const id = json.order.id;
    await pay(t, id);
    await call('POST', `/v1/orders/${id}/dispatch-request`, { requestRef: 'OC-2' }, t);
    await call(
      'POST',
      `/v1/orders/${id}/supplier-response`,
      { decision: 'ACCEPTED', confirmationRef: 'Confirmación' },
      t,
    );
    await call(
      'POST',
      `/v1/orders/${id}/shipments`,
      {
        carrier: 'OCA',
        trackingNumber: 'OCA9999',
        confirmationSource: 'SUPPLIER_DOCUMENT',
        confirmationRef: 'Remito',
        shippedAt: nowIso(),
      },
      t,
    );
    await call(
      'POST',
      `/v1/orders/${id}/shipment-events`,
      { status: 'DELIVERED', evidenceRef: 'Entrega', occurredAt: nowIso() },
      t,
    );
    await call(
      'POST',
      `/v1/orders/${id}/ledger`,
      {
        type: 'SUPPLIER_COST',
        amountCents: 70_000,
        currency: 'ARS',
        sourceRef: 'Factura con recargo',
        occurredAt: nowIso(),
      },
      t,
    );
    const d = (await call('GET', `/v1/orders/${id}`, undefined, t)).json;
    expect(d.order.state).toBe('MANUAL_REVIEW');
    expect(d.reconciliation.status).toBe('MISMATCH');
  });

  it('proveedor sin respuesta: el agente lo marca, se excluye y se elige otro verificado', async () => {
    env = { ...env, COMMERCIAL_ACTIONS_ENABLED: 'true' };
    const t = await tenantOf('tienda-a');
    const { productId, supplierA } = await setup(t);
    const supplierB = await verifiedSupplier(t, 'Proveedor B SRL');
    await offer(t, supplierB, productId, 45_000, { status: 'IN_STOCK', quantity: 3 });
    const { json } = await newOrder(t, productId);
    const id = json.order.id;
    const paid = await pay(t, id);
    expect(paid.json.supplierOrders[0].supplierId).toBe(supplierA);
    await call(
      'POST',
      `/v1/orders/${id}/dispatch-request`,
      { requestRef: 'OC-3', responseHours: 4 },
      t,
    );
    expect(await scanSupplierTimeouts(rtFor(t, new Date(Date.now() + 5 * 3_600_000)))).toEqual({
      marked: 1,
    });
    const d = (await call('GET', `/v1/orders/${id}`, undefined, t)).json;
    expect(d.order.state).toBe('FINANCIAL_APPROVED');
    const statuses = d.supplierOrders.map((s: Json) => [s.supplierId, s.status]);
    expect(statuses).toEqual(
      expect.arrayContaining([
        [supplierA, 'NO_RESPONSE'],
        [supplierB, 'SELECTED'],
      ]),
    );
    expect(d.events.map((e: Json) => e.toState)).toContain('BLOCKED_SUPPLIER');
  });

  it('proveedor que rechaza y sin alternativa → BLOCKED_SUPPLIER', async () => {
    env = { ...env, COMMERCIAL_ACTIONS_ENABLED: 'true' };
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t);
    const { json } = await newOrder(t, productId);
    await pay(t, json.order.id);
    await call('POST', `/v1/orders/${json.order.id}/dispatch-request`, { requestRef: 'OC-4' }, t);
    const r = await call(
      'POST',
      `/v1/orders/${json.order.id}/supplier-response`,
      { decision: 'REJECTED', reason: 'Sin capacidad esta semana' },
      t,
    );
    expect(r.json.order.state).toBe('BLOCKED_SUPPLIER');
  });

  it('envío sin entrega 72 h después de lo estimado → MANUAL_REVIEW; demora informada se comunica', async () => {
    env = { ...env, COMMERCIAL_ACTIONS_ENABLED: 'true' };
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t);
    const { json } = await newOrder(t, productId);
    const id = json.order.id;
    await pay(t, id);
    await call('POST', `/v1/orders/${id}/dispatch-request`, { requestRef: 'OC-5' }, t);
    await call(
      'POST',
      `/v1/orders/${id}/supplier-response`,
      { decision: 'ACCEPTED', confirmationRef: 'Confirmación' },
      t,
    );
    await call(
      'POST',
      `/v1/orders/${id}/shipments`,
      {
        carrier: 'Correo',
        trackingNumber: 'CP123456',
        confirmationSource: 'CARRIER_TRACKING',
        confirmationRef: 'Admisión',
        shippedAt: ago(100),
        estimatedDeliveryAt: ago(80),
      },
      t,
    );
    const delayed = await call(
      'POST',
      `/v1/orders/${id}/shipment-events`,
      { status: 'DELAYED', evidenceRef: 'Aviso del transportista', occurredAt: nowIso() },
      t,
    );
    expect(delayed.json.order.state).toBe('MANUAL_REVIEW');
    expect(delayed.json.buyerStatus).toContain('en revisión');
  });
});

describe('cancelaciones, devoluciones y revisión manual', () => {
  it('cancelar sin cobro → CANCELLED; con cobro → REFUND_REQUIRED hasta registrar el reembolso', async () => {
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t);
    const unpaid = await newOrder(t, productId);
    expect(
      (
        await call(
          'POST',
          `/v1/orders/${unpaid.json.order.id}/cancel`,
          { reason: 'Pidió anular' },
          t,
        )
      ).json.order.state,
    ).toBe('CANCELLED');

    const paid = await newOrder(t, productId);
    await pay(t, paid.json.order.id);
    const c = await call(
      'POST',
      `/v1/orders/${paid.json.order.id}/cancel`,
      { reason: 'Arrepentimiento' },
      t,
    );
    expect(c.json.order.state).toBe('REFUND_REQUIRED');
    expect(c.json.supplierOrders.every((s: Json) => s.status === 'CANCELLED')).toBe(true);
    const exec = await call(
      'POST',
      `/v1/orders/${paid.json.order.id}/refund-execution`,
      undefined,
      t,
    );
    expect(exec.status).toBe(403);
    const refund = await call(
      'POST',
      `/v1/orders/${paid.json.order.id}/payments`,
      {
        kind: 'REFUND',
        provider: 'Mercado Pago',
        externalPaymentId: 'MP-1001-R',
        status: 'APPROVED',
        amountCents: 100_000,
        currency: 'ARS',
        evidenceSource: 'PAYMENT_PROVIDER_REPORT',
        evidenceRef: 'Comprobante de devolución',
        observedAt: nowIso(),
      },
      t,
    );
    expect(refund.json.order).toMatchObject({ state: 'CANCELLED', refunded: true });
    expect(refund.json.buyerStatus).toContain('reintegro');
  });

  it('una decisión manual no puede saltear la evidencia', async () => {
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t);
    const { json } = await newOrder(t, productId);
    await call(
      'POST',
      `/v1/orders/${json.order.id}/resolve`,
      { to: 'MANUAL_REVIEW', reason: 'Revisar comprador' },
      t,
    );
    const skip = await call(
      'POST',
      `/v1/orders/${json.order.id}/resolve`,
      { to: 'PAYMENT_CONFIRMED', reason: 'Dice que pagó' },
      t,
    );
    expect(skip.status).toBe(409);
    expect(skip.json.error.details.missing[0]).toContain('evidencia del canal de pago');
    const shipped = await call(
      'POST',
      `/v1/orders/${json.order.id}/resolve`,
      { to: 'SHIPPED', reason: 'ya salió' },
      t,
    );
    expect(shipped.status).toBe(409);
  });

  it('devolución: solicitada, aprobada, recibida con comprobante → reintegro → CANCELLED', async () => {
    env = { ...env, COMMERCIAL_ACTIONS_ENABLED: 'true' };
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t);
    const { json } = await newOrder(t, productId);
    const id = json.order.id;
    await pay(t, id);
    await call('POST', `/v1/orders/${id}/dispatch-request`, { requestRef: 'OC-6' }, t);
    await call(
      'POST',
      `/v1/orders/${id}/supplier-response`,
      { decision: 'ACCEPTED', confirmationRef: 'Confirmación' },
      t,
    );
    await call(
      'POST',
      `/v1/orders/${id}/shipments`,
      {
        carrier: 'OCA',
        trackingNumber: 'OCA1234',
        confirmationSource: 'SUPPLIER_DOCUMENT',
        confirmationRef: 'Remito',
        shippedAt: nowIso(),
      },
      t,
    );
    await call(
      'POST',
      `/v1/orders/${id}/shipment-events`,
      { status: 'DELIVERED', evidenceRef: 'Entrega', occurredAt: nowIso() },
      t,
    );
    expect(
      (await call('POST', `/v1/orders/${id}/cancel`, { reason: 'ya no lo quiere' }, t)).status,
    ).toBe(409);
    await call('POST', `/v1/orders/${id}/returns`, { reason: 'Talle incorrecto' }, t);
    await call(
      'POST',
      `/v1/orders/${id}/returns/decision`,
      { decision: 'APPROVE', note: 'Dentro del plazo' },
      t,
    );
    const received = await call(
      'POST',
      `/v1/orders/${id}/returns/received`,
      { evidenceRef: 'Recepción en depósito del proveedor' },
      t,
    );
    expect(received.json.order.state).toBe('REFUND_REQUIRED');
    const refunded = await call(
      'POST',
      `/v1/orders/${id}/payments`,
      {
        kind: 'REFUND',
        provider: 'Mercado Pago',
        externalPaymentId: 'R-1',
        status: 'APPROVED',
        amountCents: 100_000,
        currency: 'ARS',
        evidenceSource: 'PAYMENT_PROVIDER_REPORT',
        evidenceRef: 'Comprobante reintegro',
        observedAt: nowIso(),
      },
      t,
    );
    expect(refunded.json.order.state).toBe('CANCELLED');
    expect(refunded.json.returns[0].status).toBe('REFUNDED');
    expect(refunded.json.reconciliation.refundsCents).toBe(-100_000);
  });
});

describe('atención al cliente', () => {
  it('consulta con término sensible se escala; las plantillas solo afirman hechos verificados', async () => {
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t);
    const { json } = await newOrder(t, productId);
    await call(
      'POST',
      '/v1/support/faqs',
      {
        question: '¿Cuánto tarda el envío?',
        answer: 'El plazo depende del proveedor; te informamos el seguimiento al despachar.',
        keywords: ['envio', 'tarda', 'demora'],
      },
      t,
    );
    const ticket = await call(
      'POST',
      '/v1/support/tickets',
      {
        orderId: json.order.id,
        channel: 'WHATSAPP',
        contactRef: 'AR.contacto',
        subject: 'Consulta',
        message: '¿Cuánto tarda el envío? Si no llega hago un reclamo',
      },
      t,
    );
    expect(ticket.status).toBe(201);
    expect(ticket.json).toMatchObject({ status: 'ESCALATED', orderNumber: 1001 });
    expect(ticket.json.escalationReason).toContain('reclamo');
    expect(ticket.json.suggestions.some((s: Json) => s.kind === 'FAQ')).toBe(true);
    const keys = ticket.json.suggestions
      .filter((s: Json) => s.kind === 'TEMPLATE')
      .map((s: Json) => s.key);
    expect(keys).toContain('PAYMENT_PENDING');
    expect(keys).not.toContain('SHIPPED');

    const shippedLie = await call(
      'POST',
      `/v1/support/tickets/${ticket.json.id}/reply`,
      { templateKey: 'SHIPPED' },
      t,
    );
    expect(shippedLie.status).toBe(409);
    const reply = await call(
      'POST',
      `/v1/support/tickets/${ticket.json.id}/reply`,
      { templateKey: 'PAYMENT_PENDING' },
      t,
    );
    const last = reply.json.messages.at(-1);
    expect(last).toMatchObject({
      direction: 'OUTBOUND',
      status: 'BLOCKED',
      templateKey: 'PAYMENT_PENDING',
    });
    const order = (await call('GET', `/v1/orders/${json.order.id}`, undefined, t)).json;
    expect(order.events.some((e: Json) => e.type === 'SUPPORT_ESCALATED')).toBe(true);
  });

  it('estado por número de pedido y FAQ sin pedido asociado', async () => {
    const t = await tenantOf('tienda-a');
    const { productId } = await setup(t);
    await newOrder(t, productId);
    const st = await call('GET', '/v1/support/order-status/1001', undefined, t);
    expect(st.json.status).toContain('Pedido #1001');
    expect((await call('GET', '/v1/support/order-status/9999', undefined, t)).status).toBe(404);
    const faq = (
      await call(
        'POST',
        '/v1/support/faqs',
        {
          question: '¿Hacen factura?',
          answer: 'Sí, emitimos factura por cada venta.',
          keywords: ['factura'],
        },
        t,
      )
    ).json;
    const tk = await call(
      'POST',
      '/v1/support/tickets',
      { channel: 'EMAIL', contactRef: 'cliente', subject: 'Factura', message: 'Necesito factura' },
      t,
    );
    expect(tk.json.status).toBe('OPEN');
    const r = await call('POST', `/v1/support/tickets/${tk.json.id}/reply`, { faqId: faq.id }, t);
    expect(r.json.messages.at(-1).body).toBe('Sí, emitimos factura por cada venta.');
    expect(
      (await call('POST', `/v1/support/tickets/${tk.json.id}/reply`, { templateKey: 'SHIPPED' }, t))
        .status,
    ).toBe(409);
  });
});

describe('simulaciones', () => {
  it('los 7 escenarios corren con las mismas reglas y terminan donde corresponde', async () => {
    const t = await tenantOf('tienda-a');
    const list = (await call('GET', '/v1/orders/simulations', undefined, t)).json.items;
    expect(list).toHaveLength(7);
    const expected: Record<string, string> = {
      HAPPY_PATH: 'SETTLED',
      PAYMENT_REJECTED: 'CANCELLED',
      NO_STOCK: 'CANCELLED',
      SUPPLIER_NO_RESPONSE: 'SUPPLIER_ORDER_ACCEPTED',
      CASHFLOW_PROBLEM: 'FINANCIAL_APPROVED',
      SHIPPING_DELAYED: 'MANUAL_REVIEW',
      RETURN: 'CANCELLED',
    };
    for (const [scenario, final] of Object.entries(expected)) {
      const r = (await call('POST', `/v1/orders/simulations/${scenario}`, undefined, t)).json;
      expect(r.finalState, scenario).toBe(final);
      expect(r.steps.length).toBeGreaterThan(1);
    }
    // Las simulaciones no crean pedidos.
    expect((await call('GET', '/v1/orders', undefined, t)).json.items).toEqual([]);
  });
});

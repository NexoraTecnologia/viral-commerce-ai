import { describe, expect, it } from 'vitest';
import type { OrderState } from '@vc/shared';
import {
  availableTemplates,
  buyerStatusText,
  escalationReason,
  matchFaqs,
  renderCustomerTemplate,
} from './customer-service';
import {
  evaluateOrderFinance,
  nextAutomaticStep,
  ORDER_TRANSITIONS,
  reconcileOrder,
  requirementsFor,
  selectSupplier,
  signedLedgerAmount,
  validateOrderTransition,
  type OrderFacts,
  type SupplierCandidate,
} from './order-engine';
import { runOrderSimulation, SIMULATION_SCENARIOS } from './simulation';

const NOW = new Date('2026-11-17T12:00:00Z');
const H = 3_600_000;

const facts = (over: Partial<OrderFacts> = {}): OrderFacts => ({
  state: 'PAYMENT_PENDING',
  totalCents: 100_000,
  currency: 'ARS',
  payments: [],
  selection: null,
  financial: null,
  supplierOrder: null,
  shipment: null,
  openReturn: null,
  reconciliation: null,
  now: NOW,
  ...over,
});

const CHARGE = {
  kind: 'CHARGE' as const,
  status: 'APPROVED' as const,
  amountCents: 100_000,
  currency: 'ARS' as const,
  evidenceRef: 'MP-1',
};
const PAID = [CHARGE];
const SHIPMENT = {
  status: 'SHIPPED' as const,
  carrier: 'Andreani',
  trackingNumber: 'AR1',
  confirmationRef: 'remito',
  estimatedDeliveryAt: new Date(NOW.getTime() + 48 * H),
  deliveryEvidenceRef: null,
};

const candidate = (over: Partial<SupplierCandidate> = {}): SupplierCandidate => ({
  supplierProductId: 'sp-a',
  productId: 'p1',
  supplierId: 'a',
  supplierName: 'A',
  supplierOperable: true,
  supplierScore: 70,
  deliveryDaysMax: 5,
  currency: 'ARS',
  wholesaleCents: 40_000,
  priceAgeHours: 1,
  stock: { status: 'IN_STOCK', quantity: 5, ageHours: 1 },
  ...over,
});
const POLICY = { currency: 'ARS' as const, maxStockAgeHours: 24, maxPriceAgeHours: 72 };

describe('máquina de estados', () => {
  it('estados terminales y todo destino existe como estado', () => {
    expect(ORDER_TRANSITIONS.SETTLED).toEqual([]);
    expect(ORDER_TRANSITIONS.CANCELLED).toEqual([]);
    for (const targets of Object.values(ORDER_TRANSITIONS))
      for (const t of targets) expect(Object.keys(ORDER_TRANSITIONS)).toContain(t);
  });

  it('transición fuera de la tabla se rechaza', () => {
    const r = validateOrderTransition('NEW', 'SHIPPED', facts({ state: 'NEW' }));
    expect(!r.ok && r.error.message).toContain('no permitida');
  });

  it('pago confirmado exige evidencia y monto total en la misma moneda', () => {
    expect(requirementsFor('PAYMENT_CONFIRMED', facts())).toHaveLength(1);
    expect(
      requirementsFor(
        'PAYMENT_CONFIRMED',
        facts({ payments: [{ ...CHARGE, amountCents: 99_999 }] }),
      ),
    ).toHaveLength(1);
    expect(
      requirementsFor('PAYMENT_CONFIRMED', facts({ payments: [{ ...CHARGE, currency: 'USD' }] })),
    ).toHaveLength(1);
    expect(
      requirementsFor('PAYMENT_CONFIRMED', facts({ payments: [{ ...CHARGE, evidenceRef: '' }] })),
    ).toHaveLength(1);
    expect(requirementsFor('PAYMENT_CONFIRMED', facts({ payments: PAID }))).toEqual([]);
  });

  it('despachado exige transportista, seguimiento y comprobante', () => {
    expect(
      requirementsFor('SHIPPED', facts({ shipment: { ...SHIPMENT, confirmationRef: '' } })),
    ).toHaveLength(1);
    expect(
      requirementsFor('SHIPPED', facts({ shipment: { ...SHIPMENT, trackingNumber: '' } })),
    ).toHaveLength(1);
    expect(requirementsFor('SHIPPED', facts({ shipment: SHIPMENT }))).toEqual([]);
  });

  it('no se cancela con dinero cobrado ni con el envío en camino', () => {
    expect(requirementsFor('CANCELLED', facts({ payments: PAID }))[0]).toContain('reembolso');
    expect(requirementsFor('CANCELLED', facts({ shipment: SHIPMENT }))[0]).toContain('devolución');
    const refunded = [...PAID, { ...CHARGE, kind: 'REFUND' as const }];
    expect(requirementsFor('CANCELLED', facts({ payments: refunded }))).toEqual([]);
  });

  it('la aprobación financiera exige APPROVED del Financial Guard', () => {
    const sel = selectSupplier([{ productId: 'p1', quantity: 1 }], [candidate()], POLICY);
    const f = facts({
      state: 'SUPPLIER_STOCK_VERIFIED',
      payments: PAID,
      selection: sel,
      financial: { decision: 'BLOCKED', issues: ['PREPAYMENT_WITHOUT_FUNDS'] },
    });
    expect(nextAutomaticStep(f)?.to).toBe('BLOCKED_CASHFLOW');
    expect(validateOrderTransition('SUPPLIER_STOCK_VERIFIED', 'FINANCIAL_APPROVED', f).ok).toBe(
      false,
    );
  });
});

describe('motor automático', () => {
  it.each<[string, Partial<OrderFacts>, OrderState | null]>([
    ['NEW → PAYMENT_PENDING', { state: 'NEW' }, 'PAYMENT_PENDING'],
    ['pago pendiente sin pagos espera', {}, null],
    ['pago rechazado cancela', { payments: [{ ...CHARGE, status: 'REJECTED' }] }, 'CANCELLED'],
    [
      'rechazado + pendiente espera',
      {
        payments: [
          { ...CHARGE, status: 'REJECTED' },
          { ...CHARGE, status: 'PENDING' },
        ],
      },
      null,
    ],
    [
      'envío aceptado sin comprobante no avanza',
      { state: 'SUPPLIER_ORDER_ACCEPTED', shipment: { ...SHIPMENT, confirmationRef: '' } },
      null,
    ],
    [
      'entregado sin evidencia no avanza',
      { state: 'SHIPPED', shipment: { ...SHIPMENT, status: 'DELIVERED' } },
      null,
    ],
    [
      '72 h sin entrega tras lo estimado → revisión',
      {
        state: 'SHIPPED',
        shipment: { ...SHIPMENT, estimatedDeliveryAt: new Date(NOW.getTime() - 73 * H) },
      },
      'MANUAL_REVIEW',
    ],
    [
      'dentro de las 72 h espera',
      {
        state: 'SHIPPED',
        shipment: { ...SHIPMENT, estimatedDeliveryAt: new Date(NOW.getTime() - 71 * H) },
      },
      null,
    ],
    [
      'entregado con devolución abierta no cierra',
      {
        state: 'DELIVERED',
        openReturn: { status: 'REQUESTED' },
        reconciliation: { status: 'MATCHED' },
      },
      null,
    ],
    [
      'conciliación con diferencia → revisión',
      { state: 'DELIVERED', reconciliation: { status: 'MISMATCH' } },
      'MANUAL_REVIEW',
    ],
    ['revisión manual nunca avanza sola', { state: 'MANUAL_REVIEW', payments: PAID }, null],
  ])('%s', (_name, over, expected) => {
    expect(nextAutomaticStep(facts(over))?.to ?? null).toBe(expected);
  });

  it('no reutiliza el proveedor que no respondió; avanza con otro', () => {
    const selA = selectSupplier([{ productId: 'p1', quantity: 1 }], [candidate()], POLICY);
    const base = {
      payments: PAID,
      supplierOrder: { supplierId: 'a', status: 'NO_RESPONSE' as const, confirmationRef: null },
    };
    expect(
      nextAutomaticStep(facts({ ...base, state: 'BLOCKED_SUPPLIER', selection: selA })),
    ).toBeNull();
    const selB = selectSupplier(
      [{ productId: 'p1', quantity: 1 }],
      [candidate({ supplierId: 'b', supplierName: 'B' })],
      POLICY,
    );
    expect(
      nextAutomaticStep(facts({ ...base, state: 'BLOCKED_SUPPLIER', selection: selB }))?.to,
    ).toBe('SUPPLIER_STOCK_VERIFIED');
    // En FINANCIAL_APPROVED, la falla de A no afecta al pedido nuevo con B.
    expect(
      nextAutomaticStep(
        facts({
          ...base,
          state: 'FINANCIAL_APPROVED',
          selection: selB,
          financial: { decision: 'APPROVED', issues: [] },
        }),
      ),
    ).toBeNull();
  });
});

describe('selección de proveedor', () => {
  const items = [{ productId: 'p1', quantity: 2 }];
  it('elige el más barato con stock y desempata por puntaje', () => {
    const r = selectSupplier(
      items,
      [
        candidate(),
        candidate({ supplierId: 'b', supplierName: 'B', wholesaleCents: 38_000 }),
        candidate({
          supplierId: 'c',
          supplierName: 'C',
          wholesaleCents: 38_000,
          supplierScore: 90,
        }),
      ],
      POLICY,
    );
    expect(r.ok && r.supplierId).toBe('c');
    expect(r.ok && r.totalCostCents).toBe(76_000);
  });
  it.each<[string, Partial<SupplierCandidate>, 'NO_STOCK' | 'NO_ELIGIBLE_SUPPLIER']>([
    ['agotado', { stock: { status: 'OUT_OF_STOCK', quantity: 0, ageHours: 1 } }, 'NO_STOCK'],
    ['sin control', { stock: null }, 'NO_STOCK'],
    ['control vencido', { stock: { status: 'IN_STOCK', quantity: 9, ageHours: 30 } }, 'NO_STOCK'],
    [
      'cantidad insuficiente',
      { stock: { status: 'IN_STOCK', quantity: 1, ageHours: 1 } },
      'NO_STOCK',
    ],
    [
      'cantidad no informada',
      { stock: { status: 'IN_STOCK', quantity: null, ageHours: 1 } },
      'NO_STOCK',
    ],
    ['no verificado', { supplierOperable: false }, 'NO_ELIGIBLE_SUPPLIER'],
    ['otra moneda', { currency: 'USD' }, 'NO_ELIGIBLE_SUPPLIER'],
  ])('%s', (_n, over, reason) => {
    const r = selectSupplier(items, [candidate(over)], POLICY);
    expect(!r.ok && r.reason).toBe(reason);
  });
  it('excluye proveedores que fallaron', () => {
    const r = selectSupplier(items, [candidate()], POLICY, ['a']);
    expect(r.ok).toBe(false);
  });
  it('un solo proveedor debe cubrir todos los ítems', () => {
    const r = selectSupplier(
      [
        { productId: 'p1', quantity: 1 },
        { productId: 'p2', quantity: 1 },
      ],
      [
        candidate(),
        candidate({
          supplierId: 'b',
          supplierName: 'B',
          productId: 'p2',
          supplierProductId: 'sp-b',
        }),
      ],
      POLICY,
    );
    expect(r.ok).toBe(false);
  });
});

describe('validación financiera del pedido', () => {
  const base = {
    totalCents: 100_000,
    supplierCostCents: 40_000,
    items: [
      {
        unitPriceCents: 100_000,
        quantity: 1,
        unitCostCents: 40_000,
        components: [{ kind: 'SHIPPING' as const, name: 'Envío', fixedCents: 5_000 }],
      },
    ],
    committedCents: 0,
    supplier: { requiresPrepayment: true, paymentDueDays: 0 },
    expectedSettlementAt: null,
    policy: { maxFundsDataAgeHours: 24, maxReturnRiskBps: 1500 },
    now: NOW,
  };
  it('sin dato de fondos bloquea', () => {
    expect(evaluateOrderFinance({ ...base, funds: null })).toMatchObject({
      decision: 'BLOCKED',
      issues: ['NO_FUNDS_DATA'],
    });
  });
  it('dato de fondos viejo bloquea', () => {
    const r = evaluateOrderFinance({
      ...base,
      funds: {
        availableCents: 1_000_000,
        asOf: new Date(NOW.getTime() - 30 * H),
        source: 'MANUAL',
      },
    });
    expect(r.issues).toContain('FUNDS_DATA_STALE');
  });
  it('descuenta lo comprometido y exige fondos si el proveedor cobra antes', () => {
    const funds = {
      availableCents: 60_000,
      asOf: new Date(NOW.getTime() - H),
      source: 'MANUAL' as const,
    };
    expect(evaluateOrderFinance({ ...base, funds }).decision).toBe('APPROVED');
    const r = evaluateOrderFinance({ ...base, funds, committedCents: 20_000 });
    expect(r).toMatchObject({ decision: 'BLOCKED', availableCents: 40_000 });
    expect(r.issues).toContain('PREPAYMENT_WITHOUT_FUNDS');
  });
  it('si el canal liquida antes del vencimiento al proveedor no hace falta adelantar fondos', () => {
    const r = evaluateOrderFinance({
      ...base,
      funds: { availableCents: 0, asOf: new Date(NOW.getTime() - H), source: 'MANUAL' },
      supplier: { requiresPrepayment: false, paymentDueDays: 30 },
      expectedSettlementAt: new Date(NOW.getTime() + 10 * 24 * H),
    });
    expect(r.decision).toBe('APPROVED');
  });
});

describe('conciliación', () => {
  const ledger = (supplier = 40_000) => [
    {
      type: 'SALE' as const,
      amountCents: signedLedgerAmount('SALE', 100_000),
      currency: 'ARS' as const,
    },
    {
      type: 'CHANNEL_FEE' as const,
      amountCents: signedLedgerAmount('CHANNEL_FEE', 13_000),
      currency: 'ARS' as const,
    },
    {
      type: 'SUPPLIER_COST' as const,
      amountCents: signedLedgerAmount('SUPPLIER_COST', supplier),
      currency: 'ARS' as const,
    },
  ];
  it('cierra dentro de la tolerancia; diferencia grande no', () => {
    expect(
      reconcileOrder(ledger(), {
        currency: 'ARS',
        expectedNetCents: 47_000,
        supplierAccepted: true,
      }).status,
    ).toBe('MATCHED');
    expect(
      reconcileOrder(ledger(40_900), {
        currency: 'ARS',
        expectedNetCents: 47_000,
        supplierAccepted: true,
      }).status,
    ).toBe('MATCHED');
    expect(
      reconcileOrder(ledger(45_000), {
        currency: 'ARS',
        expectedNetCents: 47_000,
        supplierAccepted: true,
      }),
    ).toMatchObject({ status: 'MISMATCH', differenceCents: -5_000 });
  });
  it('faltan datos → PENDING_DATA; otra moneda → MISMATCH', () => {
    expect(
      reconcileOrder([], { currency: 'ARS', expectedNetCents: 1, supplierAccepted: true }).missing,
    ).toEqual(['SALE', 'SUPPLIER_COST']);
    const foreign = [
      ...ledger(),
      { type: 'ADJUSTMENT' as const, amountCents: 5, currency: 'USD' as const },
    ];
    expect(
      reconcileOrder(foreign, { currency: 'ARS', expectedNetCents: 47_000, supplierAccepted: true })
        .status,
    ).toBe('MISMATCH');
  });
  it('signos por tipo', () => {
    expect(signedLedgerAmount('REFUND', 500)).toBe(-500);
    expect(signedLedgerAmount('ADJUSTMENT', -20)).toBe(-20);
    expect(signedLedgerAmount('SALE', -10)).toBe(10);
  });
});

describe('atención al cliente', () => {
  const cf = (over: Partial<OrderFacts> = {}) => ({
    orderNumber: 7,
    order: facts(over),
    returnWindowDays: 30,
    deliveredAt: null,
  });
  it('nunca dice "despachado" sin comprobante', () => {
    const noProof = cf({
      state: 'SHIPPED',
      payments: PAID,
      shipment: { ...SHIPMENT, confirmationRef: '' },
    });
    expect(renderCustomerTemplate('SHIPPED', noProof).ok).toBe(false);
    expect(buyerStatusText(noProof)).not.toContain('despachado');
    const ok = renderCustomerTemplate(
      'SHIPPED',
      cf({ state: 'SHIPPED', payments: PAID, shipment: SHIPMENT }),
    );
    expect(ok.ok && ok.value).toContain('AR1');
  });
  it('bloqueos se informan como "en revisión" sin detalles internos', () => {
    for (const s of [
      'BLOCKED_NO_STOCK',
      'BLOCKED_CASHFLOW',
      'BLOCKED_SUPPLIER',
      'MANUAL_REVIEW',
    ] as const)
      expect(buyerStatusText(cf({ state: s }))).toContain('en revisión');
  });
  it('pago confirmado solo con evidencia; demora solo si la informó el transportista', () => {
    expect(renderCustomerTemplate('PAYMENT_CONFIRMED', cf()).ok).toBe(false);
    expect(
      renderCustomerTemplate('SHIPPING_DELAYED', cf({ state: 'SHIPPED', shipment: SHIPMENT })).ok,
    ).toBe(false);
    expect(
      renderCustomerTemplate(
        'SHIPPING_DELAYED',
        cf({ state: 'SHIPPED', shipment: { ...SHIPMENT, status: 'DELAYED' } }),
      ).ok,
    ).toBe(true);
  });
  it('devolución: requiere plazo registrado y que no haya vencido', () => {
    const delivered = { ...SHIPMENT, status: 'DELIVERED' as const, deliveryEvidenceRef: 'x' };
    expect(
      renderCustomerTemplate('RETURN_INSTRUCTIONS', {
        ...cf({ state: 'DELIVERED', shipment: delivered }),
        returnWindowDays: null,
      }).ok,
    ).toBe(false);
    expect(
      renderCustomerTemplate('RETURN_INSTRUCTIONS', {
        ...cf({ state: 'DELIVERED', shipment: delivered }),
        deliveredAt: new Date(NOW.getTime() - 31 * 24 * H),
      }).ok,
    ).toBe(false);
    expect(
      renderCustomerTemplate('RETURN_INSTRUCTIONS', {
        ...cf({ state: 'DELIVERED', shipment: delivered }),
        deliveredAt: new Date(NOW.getTime() - 2 * 24 * H),
      }).ok,
    ).toBe(true);
  });
  it('plantillas disponibles dependen del estado real', () => {
    expect(availableTemplates(cf()).map((t) => t.key)).toEqual([
      'ORDER_RECEIVED',
      'PAYMENT_PENDING',
      'ESCALATED',
    ]);
  });
  it('FAQ por palabras clave (sin acentos) y escalamiento', () => {
    const faqs = [
      { id: '1', keywords: ['envio', 'demora'], active: true },
      { id: '2', keywords: ['factura'], active: true },
      { id: '3', keywords: ['envio'], active: false },
    ];
    expect(matchFaqs('¿Cuánto demora el envío?', faqs).map((f) => f.id)).toEqual(['1']);
    expect(escalationReason('Voy a hacer una denuncia en Defensa del Consumidor', null)).toContain(
      'denuncia',
    );
    expect(escalationReason('Hola, consulta', 'MANUAL_REVIEW')).toContain('MANUAL_REVIEW');
    expect(escalationReason('Hola, consulta', 'SHIPPED')).toBeNull();
  });
});

describe('simulaciones', () => {
  it.each(SIMULATION_SCENARIOS)('%s es determinística y respeta las reglas', (s) => {
    const a = runOrderSimulation(s, NOW);
    expect(runOrderSimulation(s, NOW)).toEqual(a);
    // Cada cambio de estado del registro fue una transición permitida.
    for (const step of a.steps)
      if (step.fromState !== step.toState)
        expect(ORDER_TRANSITIONS[step.fromState]).toContain(step.toState);
  });
  it('resultado esperado por escenario', () => {
    const finals = Object.fromEntries(
      SIMULATION_SCENARIOS.map((s) => [s, runOrderSimulation(s, NOW).finalState]),
    );
    expect(finals).toEqual({
      HAPPY_PATH: 'SETTLED',
      PAYMENT_REJECTED: 'CANCELLED',
      NO_STOCK: 'CANCELLED',
      SUPPLIER_NO_RESPONSE: 'SUPPLIER_ORDER_ACCEPTED',
      CASHFLOW_PROBLEM: 'FINANCIAL_APPROVED',
      SHIPPING_DELAYED: 'MANUAL_REVIEW',
      RETURN: 'CANCELLED',
    });
  });
  it('compra correcta: el aviso de despacho antes del despacho real NO se envía', () => {
    const r = runOrderSimulation('HAPPY_PATH', NOW);
    expect(r.buyerMessages.some((m) => m.startsWith('[No enviado]'))).toBe(true);
    expect(r.blockedActions.length).toBeGreaterThan(0);
  });
});

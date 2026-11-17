import type { OrderState, SimulationResultDto, SimulationScenario } from '@vc/shared';
import { buyerStatusText, renderCustomerTemplate } from './customer-service';
import {
  evaluateOrderFinance,
  nextAutomaticStep,
  reconcileOrder,
  selectSupplier,
  signedLedgerAmount,
  validateOrderTransition,
  type OrderFacts,
  type SupplierCandidate,
} from './order-engine';

/**
 * SIMULACIONES del Order Engine. Corren las MISMAS reglas puras que los pedidos
 * reales (máquina de estados, selección de proveedor, Financial Guard,
 * conciliación y plantillas) sobre datos SINTÉTICOS, en memoria: no tocan la
 * base, no llaman a terceros y no ejecutan transacciones.
 */

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const H = 3_600_000;
const POLICY = {
  maxStockAgeHours: 24,
  maxPriceAgeHours: 72,
  maxFundsDataAgeHours: 24,
  maxReturnRiskBps: 1500,
};

/** Datos sintéticos de la simulación (montos de ejemplo, no son datos reales). */
const SIM = {
  orderNumber: 1001,
  total: 100_000,
  productId: 'sim-producto',
  quantity: 1,
  components: [
    { kind: 'CHANNEL_COMMISSION' as const, name: 'Comisión (sim)', rateBps: 1300 },
    { kind: 'SHIPPING' as const, name: 'Envío (sim)', fixedCents: 5_000 },
  ],
};

const supplier = (id: string, over: Partial<SupplierCandidate> = {}): SupplierCandidate => ({
  supplierProductId: `${id}-oferta`,
  productId: SIM.productId,
  supplierId: id,
  supplierName: id === 'sim-proveedor-a' ? 'Proveedor A (sim)' : 'Proveedor B (sim)',
  supplierOperable: true,
  supplierScore: 80,
  deliveryDaysMax: 5,
  currency: 'ARS',
  wholesaleCents: 40_000,
  priceAgeHours: 2,
  stock: { status: 'IN_STOCK', quantity: 10, ageHours: 2 },
  ...over,
});

interface Runner {
  readonly f: Mutable<OrderFacts>;
  readonly steps: SimulationResultDto['steps'];
  readonly buyerMessages: string[];
  readonly blockedActions: string[];
  t: number;
}

const newRunner = (start: Date): Runner => ({
  f: {
    state: 'NEW',
    totalCents: SIM.total,
    currency: 'ARS',
    payments: [],
    selection: null,
    financial: null,
    supplierOrder: null,
    shipment: null,
    openReturn: null,
    reconciliation: null,
    now: start,
  },
  steps: [],
  buyerMessages: [],
  blockedActions: [],
  t: start.getTime(),
});

const at = (r: Runner) => new Date(r.t).toISOString();

const record = (r: Runner, event: string, from: OrderState, to: OrderState, detail: string) =>
  r.steps.push({ at: at(r), event, fromState: from, toState: to, detail });

/** Corre el motor hasta que no haya más pasos automáticos. */
const settle = (r: Runner) => {
  for (let i = 0; i < 20; i++) {
    r.f.now = new Date(r.t);
    const d = nextAutomaticStep(r.f);
    if (!d) return;
    const from = r.f.state;
    r.f.state = d.to;
    record(r, 'Motor', from, d.to, d.reason);
  }
};

/** Evento externo: avanza el reloj, aplica el cambio de hechos y corre el motor. */
const event = (r: Runner, hours: number, name: string, apply: () => void, detail = '') => {
  r.t += hours * H;
  r.f.now = new Date(r.t);
  apply();
  record(r, name, r.f.state, r.f.state, detail || name);
  settle(r);
};

const decide = (r: Runner, to: OrderState, reason: string) => {
  const v = validateOrderTransition(r.f.state, to, r.f);
  if (!v.ok) {
    record(r, 'Decisión rechazada', r.f.state, r.f.state, v.error.message);
    return;
  }
  const from = r.f.state;
  r.f.state = to;
  record(r, 'Decisión del administrador', from, to, reason);
  settle(r);
};

const say = (r: Runner) =>
  r.buyerMessages.push(
    buyerStatusText({
      orderNumber: SIM.orderNumber,
      order: r.f,
      returnWindowDays: 30,
      deliveredAt: null,
    }),
  );

const template = (
  r: Runner,
  key: Parameters<typeof renderCustomerTemplate>[0],
  deliveredAt: Date | null = null,
) => {
  const t = renderCustomerTemplate(key, {
    orderNumber: SIM.orderNumber,
    order: r.f,
    returnWindowDays: 30,
    deliveredAt,
  });
  r.buyerMessages.push(t.ok ? t.value : `[No enviado] ${t.error.message}`);
};

const pay = (r: Runner, status: 'APPROVED' | 'REJECTED') => {
  event(
    r,
    0.1,
    status === 'APPROVED' ? 'Pago aprobado (evidencia del canal)' : 'Pago rechazado',
    () => {
      r.f.payments = [
        ...r.f.payments,
        {
          kind: 'CHARGE',
          status,
          amountCents: SIM.total,
          currency: 'ARS',
          evidenceRef: 'sim-notificacion-pago-1',
        },
      ];
    },
  );
};

const verifyStock = (
  r: Runner,
  candidates: readonly SupplierCandidate[],
  excluded: string[] = [],
) => {
  event(r, 0.2, 'Verificación de stock y selección de proveedor', () => {
    r.f.selection = selectSupplier(
      [{ productId: SIM.productId, quantity: SIM.quantity }],
      candidates,
      { currency: 'ARS', ...POLICY },
      excluded,
    );
    r.f.financial = null;
  });
};

const finance = (r: Runner, availableCents: number | null) => {
  event(r, 0.1, 'Validación financiera', () => {
    const cost = r.f.selection?.ok ? r.f.selection.totalCostCents : 0;
    const res = evaluateOrderFinance({
      totalCents: SIM.total,
      supplierCostCents: cost,
      items: [
        { unitPriceCents: SIM.total, quantity: 1, components: SIM.components, unitCostCents: cost },
      ],
      funds:
        availableCents === null
          ? null
          : { availableCents, asOf: new Date(r.t - H), source: 'MANUAL' },
      committedCents: 0,
      supplier: { requiresPrepayment: true, paymentDueDays: 0 },
      expectedSettlementAt: null,
      policy: POLICY,
      now: new Date(r.t),
    });
    r.f.financial = { decision: res.decision, issues: res.issues };
  });
};

const requestDispatch = (r: Runner) => {
  r.blockedActions.push(
    'Solicitud de despacho al proveedor: en un pedido real requiere COMMERCIAL_ACTIONS_ENABLED=true y referencia del pedido enviado',
  );
  event(r, 0.5, 'Solicitud de despacho (simulada)', () => {
    r.f.supplierOrder = {
      supplierId: r.f.selection?.ok ? r.f.selection.supplierId : '',
      status: 'REQUESTED',
      confirmationRef: null,
    };
  });
};

const supplierAccepts = (r: Runner) => {
  event(r, 3, 'Proveedor confirma (comprobante)', () => {
    if (r.f.supplierOrder)
      r.f.supplierOrder = {
        ...r.f.supplierOrder,
        status: 'ACCEPTED',
        confirmationRef: 'sim-confirmacion-proveedor',
      };
  });
};

const ship = (r: Runner, etaHours: number) => {
  event(r, 20, 'Despacho con guía del transportista', () => {
    r.f.shipment = {
      status: 'SHIPPED',
      carrier: 'Transportista (sim)',
      trackingNumber: 'SIM123456AR',
      confirmationRef: 'sim-guia-despacho',
      estimatedDeliveryAt: new Date(r.t + etaHours * H),
      deliveryEvidenceRef: null,
    };
  });
};

const deliver = (r: Runner) => {
  event(r, 48, 'Entrega informada por el transportista', () => {
    if (r.f.shipment)
      r.f.shipment = {
        ...r.f.shipment,
        status: 'DELIVERED',
        deliveryEvidenceRef: 'sim-evento-entrega',
      };
    r.f.reconciliation = { status: 'PENDING_DATA' };
  });
};

const reconcile = (r: Runner) => {
  event(r, 72, 'Conciliación con liquidación del canal y factura del proveedor', () => {
    const cost = r.f.selection?.ok ? r.f.selection.totalCostCents : 0;
    const ledger = [
      {
        type: 'SALE' as const,
        amountCents: signedLedgerAmount('SALE', SIM.total),
        currency: 'ARS' as const,
      },
      {
        type: 'CHANNEL_FEE' as const,
        amountCents: signedLedgerAmount('CHANNEL_FEE', 13_000),
        currency: 'ARS' as const,
      },
      {
        type: 'SHIPPING_COST' as const,
        amountCents: signedLedgerAmount('SHIPPING_COST', 5_000),
        currency: 'ARS' as const,
      },
      {
        type: 'SUPPLIER_COST' as const,
        amountCents: signedLedgerAmount('SUPPLIER_COST', cost),
        currency: 'ARS' as const,
      },
    ];
    r.f.reconciliation = {
      status: reconcileOrder(ledger, {
        currency: 'ARS',
        expectedNetCents: SIM.total - 13_000 - 5_000 - cost,
        supplierAccepted: true,
      }).status,
    };
  });
};

const refund = (r: Runner) => {
  r.blockedActions.push(
    'Reembolso: el sistema no lo ejecuta; se hace en el medio de pago y se registra con evidencia',
  );
  event(r, 24, 'Reembolso registrado con evidencia del medio de pago', () => {
    r.f.payments = [
      ...r.f.payments,
      {
        kind: 'REFUND',
        status: 'APPROVED',
        amountCents: SIM.total,
        currency: 'ARS',
        evidenceRef: 'sim-comprobante-reintegro',
      },
    ];
  });
};

const SCENARIOS: Record<
  SimulationScenario,
  { title: string; description: string; run: (r: Runner) => void }
> = {
  HAPPY_PATH: {
    title: 'Compra correcta',
    description:
      'Pago aprobado, stock confirmado, fondos suficientes, despacho, entrega y conciliación.',
    run: (r) => {
      settle(r);
      template(r, 'ORDER_RECEIVED');
      pay(r, 'APPROVED');
      template(r, 'PAYMENT_CONFIRMED');
      verifyStock(r, [
        supplier('sim-proveedor-a'),
        supplier('sim-proveedor-b', { wholesaleCents: 42_000 }),
      ]);
      finance(r, 200_000);
      requestDispatch(r);
      supplierAccepts(r);
      template(r, 'SHIPPED');
      ship(r, 72);
      template(r, 'SHIPPED');
      deliver(r);
      template(r, 'DELIVERED', new Date(r.t));
      reconcile(r);
    },
  },
  PAYMENT_REJECTED: {
    title: 'Pago rechazado',
    description:
      'El medio de pago rechaza el cobro: el pedido se cancela sin pedir nada al proveedor.',
    run: (r) => {
      settle(r);
      pay(r, 'REJECTED');
      say(r);
    },
  },
  NO_STOCK: {
    title: 'Sin stock',
    description: 'Ningún proveedor verificado tiene stock: se bloquea y se gestiona el reintegro.',
    run: (r) => {
      settle(r);
      pay(r, 'APPROVED');
      verifyStock(r, [
        supplier('sim-proveedor-a', {
          stock: { status: 'OUT_OF_STOCK', quantity: 0, ageHours: 1 },
        }),
        supplier('sim-proveedor-b', { stock: { status: 'IN_STOCK', quantity: 5, ageHours: 40 } }),
      ]);
      say(r);
      decide(r, 'REFUND_REQUIRED', 'Sin reposición confirmada: corresponde reintegrar');
      template(r, 'REFUND_IN_PROCESS');
      refund(r);
      say(r);
    },
  },
  SUPPLIER_NO_RESPONSE: {
    title: 'Proveedor sin respuesta',
    description:
      'El proveedor no confirma en el plazo: se bloquea, se excluye y se elige otro verificado.',
    run: (r) => {
      settle(r);
      pay(r, 'APPROVED');
      verifyStock(r, [
        supplier('sim-proveedor-a'),
        supplier('sim-proveedor-b', { wholesaleCents: 43_000 }),
      ]);
      finance(r, 200_000);
      requestDispatch(r);
      event(r, 24, 'Vence el plazo de respuesta del proveedor', () => {
        if (r.f.supplierOrder) r.f.supplierOrder = { ...r.f.supplierOrder, status: 'NO_RESPONSE' };
      });
      say(r);
      verifyStock(
        r,
        [supplier('sim-proveedor-a'), supplier('sim-proveedor-b', { wholesaleCents: 43_000 })],
        ['sim-proveedor-a'],
      );
      finance(r, 200_000);
      requestDispatch(r);
      supplierAccepts(r);
      template(r, 'IN_PREPARATION');
    },
  },
  CASHFLOW_PROBLEM: {
    title: 'Problema financiero',
    description:
      'El proveedor cobra por adelantado y no hay fondos: nunca se le ordena. Se aprueba al registrar fondos.',
    run: (r) => {
      settle(r);
      pay(r, 'APPROVED');
      verifyStock(r, [supplier('sim-proveedor-a')]);
      finance(r, 10_000);
      say(r);
      finance(r, null);
      event(r, 4, 'Se registra un saldo actualizado (extracto)', () => undefined);
      finance(r, 150_000);
      template(r, 'IN_PREPARATION');
    },
  },
  SHIPPING_DELAYED: {
    title: 'Envío demorado',
    description:
      'El transportista informa demora; al superar 72 h sobre lo estimado pasa a revisión manual.',
    run: (r) => {
      settle(r);
      pay(r, 'APPROVED');
      verifyStock(r, [supplier('sim-proveedor-a')]);
      finance(r, 200_000);
      requestDispatch(r);
      supplierAccepts(r);
      ship(r, 48);
      event(r, 50, 'Transportista informa demora', () => {
        if (r.f.shipment) r.f.shipment = { ...r.f.shipment, status: 'DELAYED' };
      });
      template(r, 'SHIPPING_DELAYED');
      event(r, 75, 'Pasan 72 h sobre la fecha estimada', () => undefined);
      say(r);
    },
  },
  RETURN: {
    title: 'Devolución',
    description: 'Entregado, el comprador devuelve: al recibirlo se exige reintegro con evidencia.',
    run: (r) => {
      settle(r);
      pay(r, 'APPROVED');
      verifyStock(r, [supplier('sim-proveedor-a')]);
      finance(r, 200_000);
      requestDispatch(r);
      supplierAccepts(r);
      ship(r, 72);
      deliver(r);
      const deliveredAt = new Date(r.t);
      event(r, 24, 'Comprador solicita devolución', () => {
        r.f.openReturn = { status: 'REQUESTED' };
      });
      template(r, 'RETURN_INSTRUCTIONS', deliveredAt);
      event(r, 2, 'Devolución aprobada', () => {
        r.f.openReturn = { status: 'APPROVED' };
      });
      event(r, 96, 'Producto devuelto recibido (comprobante)', () => {
        r.f.openReturn = { status: 'RECEIVED' };
        if (r.f.shipment) r.f.shipment = { ...r.f.shipment, status: 'RETURNED' };
      });
      template(r, 'REFUND_IN_PROCESS');
      refund(r);
      say(r);
    },
  },
};

export const SIMULATION_SCENARIOS = Object.keys(SCENARIOS) as SimulationScenario[];

export const runOrderSimulation = (
  scenario: SimulationScenario,
  start: Date,
): SimulationResultDto => {
  const def = SCENARIOS[scenario];
  const r = newRunner(start);
  def.run(r);
  return {
    scenario,
    title: def.title,
    description: def.description,
    steps: r.steps,
    finalState: r.f.state,
    buyerMessages: r.buyerMessages,
    blockedActions: r.blockedActions,
  };
};

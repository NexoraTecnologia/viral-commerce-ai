import { useState, type ReactNode, type SubmitEvent } from 'react';
import type {
  LedgerEntryType,
  OrderDetailDto,
  OrderState,
  PaymentEvidenceSource,
  ShipmentConfirmationSource,
  SimulationResultDto,
  SimulationScenario,
} from '@vc/shared';
import { api } from '../api-client';
import { formatCents, formatDateTime, parseMoneyInput, type Tone } from '../format';
import {
  Badge,
  ControlsPager,
  Empty,
  ErrorText,
  Field,
  ListToolbar,
  Loading,
  Panel,
  useAction,
  useAsync,
  useListControls,
} from '../ui';

/* ------------------------------- Etiquetas ------------------------------- */

export const STATE_LABEL: Record<OrderState, string> = {
  NEW: 'Nuevo',
  PAYMENT_PENDING: 'Pago pendiente',
  PAYMENT_CONFIRMED: 'Pago confirmado',
  SUPPLIER_STOCK_VERIFIED: 'Stock verificado',
  FINANCIAL_APPROVED: 'Aprobado financieramente',
  SUPPLIER_ORDER_ACCEPTED: 'Aceptado por proveedor',
  SHIPPED: 'Despachado',
  DELIVERED: 'Entregado',
  SETTLED: 'Conciliado',
  BLOCKED_NO_STOCK: 'Bloqueado: sin stock',
  BLOCKED_CASHFLOW: 'Bloqueado: fondos',
  BLOCKED_SUPPLIER: 'Bloqueado: proveedor',
  MANUAL_REVIEW: 'Revisión manual',
  REFUND_REQUIRED: 'Reintegro pendiente',
  CANCELLED: 'Cancelado',
};
export const stateTone = (s: OrderState): Tone =>
  s === 'SETTLED' || s === 'DELIVERED'
    ? 'good'
    : s.startsWith('BLOCKED') || s === 'REFUND_REQUIRED'
      ? 'bad'
      : s === 'MANUAL_REVIEW' || s === 'CANCELLED'
        ? 'warn'
        : 'neutral';

const SCENARIO_LABEL: Record<SimulationScenario, string> = {
  HAPPY_PATH: 'Compra correcta',
  PAYMENT_REJECTED: 'Pago rechazado',
  NO_STOCK: 'Sin stock',
  SUPPLIER_NO_RESPONSE: 'Proveedor sin respuesta',
  CASHFLOW_PROBLEM: 'Problema financiero',
  SHIPPING_DELAYED: 'Envío demorado',
  RETURN: 'Devolución',
};

const nowLocal = () => new Date().toISOString();

/** Formulario de una línea: valor + botón (referencias, motivos, comprobantes). */
const OneField = ({
  label,
  button,
  hint,
  busy,
  onSubmit,
}: {
  label: string;
  button: string;
  hint?: string;
  busy: boolean;
  onSubmit: (value: string) => Promise<boolean>;
}) => {
  const [v, setV] = useState('');
  return (
    <form
      className="form inline-form"
      onSubmit={(e: SubmitEvent) => {
        e.preventDefault();
        void onSubmit(v).then((ok) => {
          if (ok) setV('');
        });
      }}
    >
      <Field label={label} hint={hint}>
        <input
          value={v}
          onChange={(e) => {
            setV(e.target.value);
          }}
          required
          minLength={3}
        />
      </Field>
      <button type="submit" disabled={busy}>
        {button}
      </button>
    </form>
  );
};

const Block = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="stack">
    <h3>{title}</h3>
    {children}
  </div>
);

/* ------------------------------- Detalle ------------------------------- */

const OrderActions = ({
  d,
  onChange,
}: {
  d: OrderDetailDto;
  onChange: (d: OrderDetailDto) => void;
}) => {
  const action = useAction();
  const id = d.order.id;
  const run = (fn: () => Promise<OrderDetailDto>) =>
    action.run(async () => {
      onChange(await fn());
    });
  const [pay, setPay] = useState({
    provider: 'Mercado Pago',
    externalPaymentId: '',
    amount: '',
    evidenceSource: 'PAYMENT_PROVIDER_REPORT' as PaymentEvidenceSource,
    evidenceRef: '',
    status: 'APPROVED' as 'APPROVED' | 'REJECTED' | 'PENDING',
  });
  const [ship, setShip] = useState({
    carrier: '',
    trackingNumber: '',
    confirmationSource: 'CARRIER_TRACKING' as ShipmentConfirmationSource,
    confirmationRef: '',
    eta: '',
  });
  const [ledger, setLedger] = useState({
    type: 'CHANNEL_FEE' as LedgerEntryType,
    amount: '',
    sourceRef: '',
  });
  const [resolve, setResolve] = useState({ to: '' as OrderState | '', reason: '' });
  const s = d.order.state;
  const requested = d.supplierOrders.find((x) => x.status === 'REQUESTED');
  const refund = s === 'REFUND_REQUIRED';
  const openReturn = d.returns.find((r) => r.status === 'REQUESTED' || r.status === 'APPROVED');

  return (
    <div className="stack">
      {(s === 'PAYMENT_PENDING' || refund) && (
        <Block
          title={
            refund
              ? 'Registrar reembolso (hecho en el medio de pago)'
              : 'Registrar pago con evidencia'
          }
        >
          <form
            className="form inline-form"
            onSubmit={(e: SubmitEvent) => {
              e.preventDefault();
              const amount = parseMoneyInput(pay.amount);
              void run(() =>
                api.orders.pay(id, {
                  kind: refund ? 'REFUND' : 'CHARGE',
                  provider: pay.provider,
                  externalPaymentId: pay.externalPaymentId,
                  status: refund ? 'APPROVED' : pay.status,
                  amountCents: amount ?? -1,
                  currency: d.order.currency,
                  evidenceSource: pay.evidenceSource,
                  evidenceRef: pay.evidenceRef,
                  observedAt: nowLocal(),
                }),
              );
            }}
          >
            <Field label="Medio de pago">
              <input
                value={pay.provider}
                onChange={(e) => {
                  setPay({ ...pay, provider: e.target.value });
                }}
                required
              />
            </Field>
            <Field label="ID de operación">
              <input
                value={pay.externalPaymentId}
                onChange={(e) => {
                  setPay({ ...pay, externalPaymentId: e.target.value });
                }}
                required
              />
            </Field>
            {!refund && (
              <Field label="Estado">
                <select
                  value={pay.status}
                  onChange={(e) => {
                    setPay({ ...pay, status: e.target.value as typeof pay.status });
                  }}
                >
                  <option value="APPROVED">Aprobado</option>
                  <option value="PENDING">Pendiente</option>
                  <option value="REJECTED">Rechazado</option>
                </select>
              </Field>
            )}
            <Field label="Monto">
              <input
                value={pay.amount}
                onChange={(e) => {
                  setPay({ ...pay, amount: e.target.value });
                }}
                required
              />
            </Field>
            <Field label="Fuente de la evidencia">
              <select
                value={pay.evidenceSource}
                onChange={(e) => {
                  setPay({ ...pay, evidenceSource: e.target.value as PaymentEvidenceSource });
                }}
              >
                <option value="PAYMENT_PROVIDER_REPORT">Reporte del medio de pago</option>
                <option value="CHANNEL_API">API del canal</option>
                <option value="CHANNEL_WEBHOOK">Notificación del canal</option>
                <option value="MANUAL_EVIDENCE">Comprobante cargado a mano</option>
              </select>
            </Field>
            <Field label="Comprobante" hint="ID de notificación, n.º de reporte, URL del panel">
              <input
                value={pay.evidenceRef}
                onChange={(e) => {
                  setPay({ ...pay, evidenceRef: e.target.value });
                }}
                required
                minLength={3}
              />
            </Field>
            <button type="submit" disabled={action.busy}>
              Registrar
            </button>
          </form>
        </Block>
      )}

      {s === 'FINANCIAL_APPROVED' && d.supplierOrders.some((x) => x.status === 'SELECTED') && (
        <Block title="Solicitar despacho al proveedor">
          <p className="muted small">
            Es una orden de compra: requiere acciones comerciales habilitadas.
          </p>
          <OneField
            label="Referencia del pedido enviado"
            button="Registrar solicitud"
            busy={action.busy}
            onSubmit={(v) => run(() => api.orders.requestDispatch(id, { requestRef: v }))}
          />
        </Block>
      )}

      {requested && (
        <Block title="Respuesta del proveedor">
          <OneField
            label="Comprobante de aceptación"
            button="Aceptó"
            busy={action.busy}
            onSubmit={(v) =>
              run(() =>
                api.orders.supplierResponse(id, { decision: 'ACCEPTED', confirmationRef: v }),
              )
            }
          />
          <OneField
            label="Motivo del rechazo"
            button="Rechazó"
            busy={action.busy}
            onSubmit={(v) =>
              run(() => api.orders.supplierResponse(id, { decision: 'REJECTED', reason: v }))
            }
          />
        </Block>
      )}

      {s === 'SUPPLIER_ORDER_ACCEPTED' && (
        <Block title="Registrar despacho">
          <form
            className="form inline-form"
            onSubmit={(e: SubmitEvent) => {
              e.preventDefault();
              void run(() =>
                api.orders.ship(id, {
                  carrier: ship.carrier,
                  trackingNumber: ship.trackingNumber,
                  confirmationSource: ship.confirmationSource,
                  confirmationRef: ship.confirmationRef,
                  shippedAt: nowLocal(),
                  ...(ship.eta
                    ? { estimatedDeliveryAt: new Date(`${ship.eta}T18:00:00-03:00`).toISOString() }
                    : {}),
                }),
              );
            }}
          >
            <Field label="Transportista">
              <input
                value={ship.carrier}
                onChange={(e) => {
                  setShip({ ...ship, carrier: e.target.value });
                }}
                required
              />
            </Field>
            <Field label="N.º de seguimiento">
              <input
                value={ship.trackingNumber}
                onChange={(e) => {
                  setShip({ ...ship, trackingNumber: e.target.value });
                }}
                required
              />
            </Field>
            <Field label="Confirmación">
              <select
                value={ship.confirmationSource}
                onChange={(e) => {
                  setShip({
                    ...ship,
                    confirmationSource: e.target.value as ShipmentConfirmationSource,
                  });
                }}
              >
                <option value="CARRIER_TRACKING">Seguimiento del transportista</option>
                <option value="SUPPLIER_DOCUMENT">Remito/guía del proveedor</option>
                <option value="CHANNEL">Informado por el canal</option>
              </select>
            </Field>
            <Field label="Comprobante" hint="Obligatorio: sin él no se informa despacho">
              <input
                value={ship.confirmationRef}
                onChange={(e) => {
                  setShip({ ...ship, confirmationRef: e.target.value });
                }}
                required
                minLength={3}
              />
            </Field>
            <Field label="Entrega estimada">
              <input
                type="date"
                value={ship.eta}
                onChange={(e) => {
                  setShip({ ...ship, eta: e.target.value });
                }}
              />
            </Field>
            <button type="submit" disabled={action.busy}>
              Registrar despacho
            </button>
          </form>
        </Block>
      )}

      {s === 'SHIPPED' && (
        <Block title="Novedad del transportista">
          <OneField
            label="Evidencia de entrega"
            button="Entregado"
            busy={action.busy}
            onSubmit={(v) =>
              run(() =>
                api.orders.shipmentEvent(id, {
                  status: 'DELIVERED',
                  evidenceRef: v,
                  occurredAt: nowLocal(),
                }),
              )
            }
          />
          <OneField
            label="Aviso de demora del transportista"
            button="Demorado"
            busy={action.busy}
            onSubmit={(v) =>
              run(() =>
                api.orders.shipmentEvent(id, {
                  status: 'DELAYED',
                  evidenceRef: v,
                  occurredAt: nowLocal(),
                }),
              )
            }
          />
        </Block>
      )}

      {s === 'DELIVERED' && !openReturn && (
        <Block title="Devolución">
          <OneField
            label="Motivo informado por el comprador"
            button="Registrar solicitud"
            busy={action.busy}
            onSubmit={(v) => run(() => api.orders.requestReturn(id, v))}
          />
        </Block>
      )}
      {openReturn?.status === 'REQUESTED' && (
        <Block title="Decidir devolución">
          <OneField
            label="Nota"
            button="Aprobar"
            busy={action.busy}
            onSubmit={(v) => run(() => api.orders.decideReturn(id, 'APPROVE', v))}
          />
          <OneField
            label="Motivo"
            button="Rechazar"
            busy={action.busy}
            onSubmit={(v) => run(() => api.orders.decideReturn(id, 'REJECT', v))}
          />
        </Block>
      )}
      {openReturn?.status === 'APPROVED' && (
        <Block title="Recepción del producto devuelto">
          <OneField
            label="Comprobante de recepción"
            button="Recibido"
            busy={action.busy}
            onSubmit={(v) => run(() => api.orders.receiveReturn(id, v))}
          />
        </Block>
      )}

      {['SUPPLIER_ORDER_ACCEPTED', 'SHIPPED', 'DELIVERED', 'MANUAL_REVIEW'].includes(s) && (
        <Block title="Movimiento económico (conciliación)">
          <form
            className="form inline-form"
            onSubmit={(e: SubmitEvent) => {
              e.preventDefault();
              const amount = parseMoneyInput(ledger.amount);
              void run(() =>
                api.orders.ledger(id, {
                  type: ledger.type,
                  amountCents: amount ?? -1,
                  currency: d.order.currency,
                  sourceRef: ledger.sourceRef,
                  occurredAt: nowLocal(),
                }),
              ).then((ok) => {
                if (ok) setLedger({ ...ledger, amount: '', sourceRef: '' });
              });
            }}
          >
            <Field label="Tipo">
              <select
                value={ledger.type}
                onChange={(e) => {
                  setLedger({ ...ledger, type: e.target.value as LedgerEntryType });
                }}
              >
                <option value="CHANNEL_FEE">Comisión del canal</option>
                <option value="PAYMENT_FEE">Costo de cobro</option>
                <option value="SUPPLIER_COST">Pago al proveedor</option>
                <option value="SHIPPING_COST">Envío</option>
                <option value="TAX">Impuesto</option>
                <option value="ADJUSTMENT">Ajuste</option>
              </select>
            </Field>
            <Field label="Monto">
              <input
                value={ledger.amount}
                onChange={(e) => {
                  setLedger({ ...ledger, amount: e.target.value });
                }}
                required
              />
            </Field>
            <Field label="Comprobante" hint="Liquidación, factura, extracto">
              <input
                value={ledger.sourceRef}
                onChange={(e) => {
                  setLedger({ ...ledger, sourceRef: e.target.value });
                }}
                required
                minLength={3}
              />
            </Field>
            <button type="submit" disabled={action.busy}>
              Registrar
            </button>
          </form>
        </Block>
      )}

      {d.allowedTransitions.length > 0 &&
        (s.startsWith('BLOCKED') || s === 'MANUAL_REVIEW' || s === 'REFUND_REQUIRED') && (
          <Block title="Decisión del administrador">
            <p className="muted small">
              Solo se ofrecen destinos cuyos requisitos de evidencia ya se cumplen.
            </p>
            <form
              className="form inline-form"
              onSubmit={(e: SubmitEvent) => {
                e.preventDefault();
                if (resolve.to)
                  void run(() =>
                    api.orders.resolve(id, {
                      to: resolve.to as OrderState,
                      reason: resolve.reason,
                    }),
                  );
              }}
            >
              <Field label="Mover a">
                <select
                  value={resolve.to}
                  onChange={(e) => {
                    setResolve({ ...resolve, to: e.target.value as OrderState });
                  }}
                  required
                >
                  <option value="">Elegir…</option>
                  {d.allowedTransitions.map((t) => (
                    <option key={t} value={t}>
                      {STATE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Motivo">
                <input
                  value={resolve.reason}
                  onChange={(e) => {
                    setResolve({ ...resolve, reason: e.target.value });
                  }}
                  required
                  minLength={3}
                />
              </Field>
              <button type="submit" disabled={action.busy}>
                Aplicar
              </button>
            </form>
          </Block>
        )}

      <div className="row-actions wrap">
        <button
          type="button"
          disabled={action.busy}
          onClick={() => void run(() => api.orders.advance(id))}
        >
          Reevaluar con datos actuales
        </button>
      </div>
      {!['SETTLED', 'CANCELLED', 'SHIPPED', 'DELIVERED'].includes(s) && (
        <OneField
          label="Motivo de cancelación"
          button="Cancelar pedido"
          busy={action.busy}
          onSubmit={(v) => run(() => api.orders.cancel(id, v))}
        />
      )}
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
};

const OrderDetail = ({ id, onChanged }: { id: string; onChanged: () => void }) => {
  const detail = useAsync(() => api.orders.get(id), id);
  const [override, setOverride] = useState<OrderDetailDto | null>(null);
  const d = override?.order.id === id ? override : detail.data;
  if (detail.loading && !d) return <Loading />;
  if (!d) return <ErrorText>{detail.error}</ErrorText>;
  const cur = d.order.currency;
  return (
    <Panel
      title={`Pedido #${d.order.number}`}
      actions={<Badge tone={stateTone(d.order.state)}>{STATE_LABEL[d.order.state]}</Badge>}
    >
      {d.order.stateReason && <p className="small muted">{d.order.stateReason}</p>}
      <p className="card small">
        <strong>Lo que se le puede decir al comprador:</strong> {d.buyerStatus}
      </p>
      <ul className="list compact">
        {d.items.map((i) => (
          <li key={i.id}>
            {i.quantity} × {i.title} — {formatCents(i.unitPriceCents, cur)}
          </li>
        ))}
        <li>
          <strong>Total {formatCents(d.order.totalCents, cur)}</strong>
        </li>
      </ul>
      {d.payments.length > 0 && (
        <Block title="Pagos">
          <ul className="list compact">
            {d.payments.map((p) => (
              <li key={p.id}>
                <Badge
                  tone={
                    p.status === 'APPROVED' ? 'good' : p.status === 'REJECTED' ? 'bad' : 'neutral'
                  }
                >
                  {p.kind === 'REFUND' ? 'Reembolso' : 'Cobro'} {p.status}
                </Badge>{' '}
                {p.provider} {p.externalPaymentId} · {formatCents(p.amountCents, p.currency)}{' '}
                <span className="muted small">
                  ({p.evidenceSource}: {p.evidenceRef})
                </span>
              </li>
            ))}
          </ul>
        </Block>
      )}
      {d.supplierOrders.length > 0 && (
        <Block title="Proveedor">
          <ul className="list compact">
            {d.supplierOrders.map((s) => (
              <li key={s.id}>
                {s.supplierName} · {s.status} · costo {formatCents(s.costCents, s.currency)}
                {s.requestRef && <span className="muted small"> · solicitud: {s.requestRef}</span>}
                {s.confirmationRef && (
                  <span className="muted small"> · confirmación: {s.confirmationRef}</span>
                )}
                {s.rejectionReason && <span className="muted small"> · {s.rejectionReason}</span>}
              </li>
            ))}
          </ul>
        </Block>
      )}
      {d.financialCheck && (
        <p className="small">
          Validación financiera:{' '}
          <Badge tone={d.financialCheck.decision === 'APPROVED' ? 'good' : 'bad'}>
            {d.financialCheck.decision}
          </Badge>{' '}
          disponible{' '}
          {d.financialCheck.availableCents === null
            ? 'sin dato'
            : formatCents(d.financialCheck.availableCents, cur)}{' '}
          · comprometido {formatCents(d.financialCheck.committedCents, cur)} · requerido{' '}
          {formatCents(d.financialCheck.requiredFundsCents, cur)}
          {d.financialCheck.issues.length > 0 && (
            <span className="muted"> · {d.financialCheck.issues.join(', ')}</span>
          )}
        </p>
      )}
      {d.shipments.map((s) => (
        <p key={s.id} className="small">
          Envío: {s.carrier} · {s.trackingNumber} · {s.status}
          {s.estimatedDeliveryAt && ` · estimada ${formatDateTime(s.estimatedDeliveryAt)}`}
          <span className="muted">
            {' '}
            ({s.confirmationSource}: {s.confirmationRef})
          </span>
        </p>
      ))}
      {d.returns.map((r) => (
        <p key={r.id} className="small">
          Devolución: {r.status} — {r.reason}
        </p>
      ))}
      <Block title="Conciliación">
        <p className="small">
          <Badge
            tone={
              d.reconciliation.status === 'MATCHED'
                ? 'good'
                : d.reconciliation.status === 'MISMATCH'
                  ? 'bad'
                  : 'neutral'
            }
          >
            {d.reconciliation.status}
          </Badge>{' '}
          neto registrado {formatCents(d.reconciliation.netCents, cur)} · esperado{' '}
          {d.reconciliation.expectedNetCents === null
            ? '—'
            : formatCents(d.reconciliation.expectedNetCents, cur)}
          {d.reconciliation.missing.length > 0 && (
            <span className="muted"> · falta: {d.reconciliation.missing.join(', ')}</span>
          )}
        </p>
        {d.ledger.length > 0 && (
          <ul className="list compact">
            {d.ledger.map((e) => (
              <li key={e.id}>
                {e.type}: {formatCents(e.amountCents, e.currency)}{' '}
                <span className="muted small">({e.sourceRef})</span>
              </li>
            ))}
          </ul>
        )}
      </Block>
      <OrderActions
        d={d}
        onChange={(n) => {
          setOverride(n);
          onChanged();
        }}
      />
      <Block title="Registro completo">
        <ol className="list compact">
          {d.events.map((e) => (
            <li key={e.id}>
              <span className="muted small">
                {formatDateTime(e.createdAt)} · {e.actor}
              </span>{' '}
              {e.type}
              {e.toState && (
                <>
                  {' '}
                  → <strong>{STATE_LABEL[e.toState]}</strong>
                </>
              )}
              {typeof e.detail['reason'] === 'string' && (
                <span className="muted small"> — {e.detail['reason']}</span>
              )}
            </li>
          ))}
        </ol>
      </Block>
    </Panel>
  );
};

/* ------------------------------- Vistas ------------------------------- */

export const OrdersView = () => {
  const list = useAsync(() => api.orders.list(), 'orders');
  const controls = useListControls(list.data?.items, {
    text: (o) => `${String(o.number)} ${o.buyerRef} ${o.externalOrderId ?? ''}`,
    filter: (o, v) =>
      v === 'OPEN'
        ? !['SETTLED', 'CANCELLED'].includes(o.state)
        : v === 'BLOCKED'
          ? o.state.startsWith('BLOCKED') ||
            o.state === 'MANUAL_REVIEW' ||
            o.state === 'REFUND_REQUIRED'
          : o.state === v,
  });
  const productsList = useAsync(() => api.products.list(), 'order-products');
  const action = useAction();
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState({ productId: '', quantity: '1', price: '', buyerRef: '' });
  const create = async (e: SubmitEvent) => {
    e.preventDefault();
    const product = productsList.data?.items.find((p) => p.id === form.productId);
    if (!product) return;
    const price = form.price ? parseMoneyInput(form.price) : product.salePriceCents;
    await action.run(async () => {
      const d = await api.orders.create({
        buyerRef: form.buyerRef,
        currency: product.currency,
        items: [
          { productId: product.id, quantity: Number(form.quantity), unitPriceCents: price ?? -1 },
        ],
      });
      setSelected(d.order.id);
      list.reload();
    });
  };
  return (
    <div className="stack">
      <Panel title="Recibir pedido">
        <p className="muted small">
          El pedido avanza solo cuando hay evidencia: pago del canal de pago, stock confirmado,
          fondos disponibles, confirmación del proveedor y comprobante de despacho.
        </p>
        <form className="form inline-form" onSubmit={(e) => void create(e)}>
          <Field label="Producto">
            <select
              value={form.productId}
              onChange={(e) => {
                setForm({ ...form, productId: e.target.value });
              }}
              required
            >
              <option value="">Elegir…</option>
              {productsList.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({formatCents(p.salePriceCents, p.currency)})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cantidad">
            <input
              type="number"
              min={1}
              value={form.quantity}
              onChange={(e) => {
                setForm({ ...form, quantity: e.target.value });
              }}
            />
          </Field>
          <Field label="Precio unitario" hint="Vacío = precio del producto">
            <input
              value={form.price}
              onChange={(e) => {
                setForm({ ...form, price: e.target.value });
              }}
            />
          </Field>
          <Field label="Comprador" hint="Alias o ID del canal (sin datos personales)">
            <input
              value={form.buyerRef}
              onChange={(e) => {
                setForm({ ...form, buyerRef: e.target.value });
              }}
              required
              minLength={2}
            />
          </Field>
          <button type="submit" disabled={action.busy}>
            Recibir
          </button>
        </form>
        <ErrorText>{action.error}</ErrorText>
      </Panel>
      <div className="split">
        <Panel title="Consultar pedidos">
          <ListToolbar
            controls={controls}
            placeholder="Buscar por número, comprador o ID del canal"
            filterLabel="Todos los estados"
            filterOptions={[
              { value: 'OPEN', label: 'Abiertos' },
              { value: 'BLOCKED', label: 'Bloqueados o en revisión' },
              ...(Object.keys(STATE_LABEL) as OrderState[]).map((s) => ({
                value: s,
                label: STATE_LABEL[s],
              })),
            ]}
          />
          {list.loading && !list.data && <Loading />}
          <ErrorText>{list.error}</ErrorText>
          {controls.filteredCount > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Estado</th>
                    <th>Total</th>
                    <th>Comprador</th>
                  </tr>
                </thead>
                <tbody>
                  {controls.pageItems.map((o) => (
                    <tr
                      key={o.id}
                      tabIndex={0}
                      className={selected === o.id ? 'selected' : ''}
                      onClick={() => {
                        setSelected(o.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') setSelected(o.id);
                      }}
                    >
                      <td>{o.number}</td>
                      <td>
                        <Badge tone={stateTone(o.state)}>{STATE_LABEL[o.state]}</Badge>
                      </td>
                      <td>{formatCents(o.totalCents, o.currency)}</td>
                      <td>{o.buyerRef}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !list.loading && (
              <Empty>
                {controls.totalCount === 0 ? 'Sin pedidos.' : 'Sin resultados para ese filtro.'}
              </Empty>
            )
          )}
          <ControlsPager controls={controls} />
        </Panel>
        {selected ? (
          <OrderDetail key={selected} id={selected} onChanged={list.reload} />
        ) : (
          <Panel title="Detalle">
            <Empty>Elegí un pedido.</Empty>
          </Panel>
        )}
      </div>
    </div>
  );
};

export const SupportView = () => {
  const tickets = useAsync(() => api.support.tickets(), 'tickets');
  const faqs = useAsync(() => api.support.faqs(), 'faqs');
  const orders = useAsync(() => api.orders.list(), 'support-orders');
  const action = useAction();
  const [form, setForm] = useState({ orderId: '', contactRef: '', subject: '', message: '' });
  const [faq, setFaq] = useState({ question: '', answer: '', keywords: '' });
  return (
    <div className="stack">
      <Panel title="Nueva consulta">
        <form
          className="form inline-form"
          onSubmit={(e: SubmitEvent) => {
            e.preventDefault();
            void action
              .run(() =>
                api.support.createTicket({
                  channel: 'WHATSAPP',
                  contactRef: form.contactRef,
                  subject: form.subject,
                  message: form.message,
                  ...(form.orderId ? { orderId: form.orderId } : {}),
                }),
              )
              .then((ok) => {
                if (ok) {
                  setForm({ orderId: '', contactRef: '', subject: '', message: '' });
                  tickets.reload();
                }
              });
          }}
        >
          <Field label="Pedido (opcional)">
            <select
              value={form.orderId}
              onChange={(e) => {
                setForm({ ...form, orderId: e.target.value });
              }}
            >
              <option value="">Sin pedido</option>
              {orders.data?.items.map((o) => (
                <option key={o.id} value={o.id}>
                  #{o.number}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Contacto">
            <input
              value={form.contactRef}
              onChange={(e) => {
                setForm({ ...form, contactRef: e.target.value });
              }}
              required
              minLength={2}
            />
          </Field>
          <Field label="Asunto">
            <input
              value={form.subject}
              onChange={(e) => {
                setForm({ ...form, subject: e.target.value });
              }}
              required
              minLength={3}
            />
          </Field>
          <Field label="Mensaje">
            <textarea
              value={form.message}
              onChange={(e) => {
                setForm({ ...form, message: e.target.value });
              }}
              required
            />
          </Field>
          <button type="submit" disabled={action.busy}>
            Registrar
          </button>
        </form>
        <ErrorText>{action.error}</ErrorText>
      </Panel>
      <Panel title="Consultas">
        {tickets.data?.items.length ? (
          <ul className="list">
            {tickets.data.items.map((t) => (
              <li key={t.id} className="card">
                <div className="panel-head">
                  <strong>
                    {t.subject}
                    {t.orderNumber ? ` · Pedido #${t.orderNumber}` : ''}
                  </strong>
                  <Badge
                    tone={
                      t.status === 'ESCALATED' ? 'bad' : t.status === 'CLOSED' ? 'neutral' : 'warn'
                    }
                  >
                    {t.status}
                  </Badge>
                </div>
                {t.escalationReason && (
                  <p className="error small">Escalada: {t.escalationReason}</p>
                )}
                <ul className="list compact">
                  {t.messages.map((m) => (
                    <li key={m.id}>
                      <Badge
                        tone={
                          m.direction === 'INBOUND'
                            ? 'neutral'
                            : m.status === 'BLOCKED'
                              ? 'bad'
                              : 'good'
                        }
                      >
                        {m.direction === 'INBOUND' ? 'Cliente' : m.status}
                      </Badge>{' '}
                      {m.body}
                      {m.detail && <span className="muted small"> ({m.detail})</span>}
                    </li>
                  ))}
                </ul>
                {t.status !== 'CLOSED' && (
                  <>
                    <p className="small muted">
                      Respuestas disponibles (solo con hechos verificados):
                    </p>
                    <div className="row-actions wrap">
                      {t.suggestions.map((s) => (
                        <button
                          key={`${s.kind}-${s.key}`}
                          type="button"
                          title={s.body}
                          disabled={action.busy}
                          onClick={() =>
                            void action
                              .run(() =>
                                api.support.reply(
                                  t.id,
                                  s.kind === 'FAQ'
                                    ? { faqId: s.key }
                                    : { templateKey: s.key as never },
                                ),
                              )
                              .then(tickets.reload)
                          }
                        >
                          {s.kind === 'FAQ' ? 'FAQ: ' : ''}
                          {s.label}
                        </button>
                      ))}
                      {t.status !== 'ESCALATED' && (
                        <button
                          type="button"
                          disabled={action.busy}
                          onClick={() =>
                            void action
                              .run(() => api.support.escalate(t.id, 'Derivada por el operador'))
                              .then(tickets.reload)
                          }
                        >
                          Escalar a administrador
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(() => api.support.close(t.id)).then(tickets.reload)
                        }
                      >
                        Cerrar
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Sin consultas.</Empty>
        )}
      </Panel>
      <Panel title="Preguntas frecuentes">
        <form
          className="form inline-form"
          onSubmit={(e: SubmitEvent) => {
            e.preventDefault();
            void action
              .run(() =>
                api.support.createFaq({
                  question: faq.question,
                  answer: faq.answer,
                  keywords: faq.keywords
                    .split(',')
                    .map((k) => k.trim())
                    .filter(Boolean),
                }),
              )
              .then((ok) => {
                if (ok) {
                  setFaq({ question: '', answer: '', keywords: '' });
                  faqs.reload();
                }
              });
          }}
        >
          <Field label="Pregunta">
            <input
              value={faq.question}
              onChange={(e) => {
                setFaq({ ...faq, question: e.target.value });
              }}
              required
              minLength={5}
            />
          </Field>
          <Field label="Respuesta">
            <textarea
              value={faq.answer}
              onChange={(e) => {
                setFaq({ ...faq, answer: e.target.value });
              }}
              required
              minLength={5}
            />
          </Field>
          <Field label="Palabras clave" hint="Separadas por coma">
            <input
              value={faq.keywords}
              onChange={(e) => {
                setFaq({ ...faq, keywords: e.target.value });
              }}
              required
            />
          </Field>
          <button type="submit" disabled={action.busy}>
            Agregar
          </button>
        </form>
        {faqs.data?.items.length ? (
          <ul className="list compact">
            {faqs.data.items.map((f) => (
              <li key={f.id}>
                <strong>{f.question}</strong> — {f.answer}{' '}
                <span className="muted small">[{f.keywords.join(', ')}]</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Sin preguntas frecuentes.</Empty>
        )}
      </Panel>
    </div>
  );
};

export const FundsView = () => {
  const funds = useAsync(() => api.funds.list(), 'funds');
  const action = useAction();
  const [form, setForm] = useState({ amount: '', sourceRef: '' });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Panel title="Fondos disponibles">
      <p className="muted small">
        La validación financiera usa el ÚLTIMO saldo registrado (con comprobante y de menos de 24 h)
        menos lo comprometido por otros pedidos. Sin saldo registrado, ningún pedido se ordena al
        proveedor.
      </p>
      <form
        className="form inline-form"
        onSubmit={(e: SubmitEvent) => {
          e.preventDefault();
          const cents = parseMoneyInput(form.amount);
          void action.run(async () => {
            const r = await api.funds.record({
              availableCents: cents ?? -1,
              currency: 'ARS',
              asOf: nowLocal(),
              source: 'MANUAL',
              sourceRef: form.sourceRef,
            });
            setMsg(
              `Saldo registrado. Pedidos bloqueados por fondos reevaluados: ${r.reevaluated.evaluated} (cambiaron ${r.reevaluated.changed}).`,
            );
            setForm({ amount: '', sourceRef: '' });
            funds.reload();
          });
        }}
      >
        <Field label="Saldo disponible (ARS)">
          <input
            value={form.amount}
            onChange={(e) => {
              setForm({ ...form, amount: e.target.value });
            }}
            required
          />
        </Field>
        <Field label="Comprobante" hint="Extracto, captura del saldo">
          <input
            value={form.sourceRef}
            onChange={(e) => {
              setForm({ ...form, sourceRef: e.target.value });
            }}
            required
            minLength={3}
          />
        </Field>
        <button type="submit" disabled={action.busy}>
          Registrar saldo actual
        </button>
      </form>
      {msg && <p className="small">{msg}</p>}
      <ErrorText>{action.error}</ErrorText>
      {funds.data?.items.length ? (
        <ul className="list compact">
          {funds.data.items.map((f) => (
            <li key={f.id}>
              {formatDateTime(f.asOf)} · {formatCents(f.availableCents, f.currency)}{' '}
              <span className="muted small">
                ({f.source}: {f.sourceRef})
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Sin saldos registrados.</Empty>
      )}
    </Panel>
  );
};

export const SimulationsView = () => {
  const action = useAction();
  const [result, setResult] = useState<SimulationResultDto | null>(null);
  return (
    <div className="stack">
      <Panel title="Simulaciones">
        <p className="muted small">
          Corren las mismas reglas que los pedidos reales sobre datos sintéticos, en memoria: no
          crean pedidos, no contactan a nadie y no mueven dinero.
        </p>
        <div className="row-actions wrap">
          {(Object.keys(SCENARIO_LABEL) as SimulationScenario[]).map((s) => (
            <button
              key={s}
              type="button"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  setResult(await api.orders.simulate(s));
                }, false)
              }
            >
              {SCENARIO_LABEL[s]}
            </button>
          ))}
        </div>
        <ErrorText>{action.error}</ErrorText>
      </Panel>
      {result && (
        <Panel title={`${result.title} — resultado: ${STATE_LABEL[result.finalState]}`}>
          <p className="small muted">{result.description}</p>
          <ol className="list compact">
            {result.steps.map((s, i) => (
              <li key={i}>
                <span className="muted small">{formatDateTime(s.at)}</span> {s.event}
                {s.fromState !== s.toState && (
                  <>
                    {' '}
                    ·{' '}
                    <Badge tone={stateTone(s.toState)}>
                      {STATE_LABEL[s.fromState]} → {STATE_LABEL[s.toState]}
                    </Badge>
                  </>
                )}
                {s.detail !== s.event && <span className="muted small"> — {s.detail}</span>}
              </li>
            ))}
          </ol>
          <h3>Mensajes al comprador</h3>
          <ul className="list compact">
            {result.buyerMessages.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          {result.blockedActions.length > 0 && (
            <>
              <h3>En un pedido real requerirían habilitación o evidencia externa</h3>
              <ul className="list compact">
                {result.blockedActions.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      )}
    </div>
  );
};

const VIEWS = [
  { id: 'pedidos', label: 'Pedidos' },
  { id: 'atencion', label: 'Atención al cliente' },
  { id: 'fondos', label: 'Fondos' },
  { id: 'simulaciones', label: 'Simulaciones' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

export const OrdersSection = () => {
  const [view, setView] = useState<ViewId>('pedidos');
  return (
    <div className="stack">
      <nav className="subtabs" aria-label="Pedidos">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={view === v.id ? 'subtab active' : 'subtab'}
            aria-pressed={view === v.id}
            onClick={() => {
              setView(v.id);
            }}
          >
            {v.label}
          </button>
        ))}
      </nav>
      {view === 'pedidos' && <OrdersView />}
      {view === 'atencion' && <SupportView />}
      {view === 'fondos' && <FundsView />}
      {view === 'simulaciones' && <SimulationsView />}
    </div>
  );
};

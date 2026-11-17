import { Fragment, useState, type SubmitEvent } from 'react';
import type { FinancialGuardResult, ProfitBreakdown } from '@vc/shared';
import { api } from '../api-client';
import {
  formatBps,
  formatCents,
  formatDateTime,
  ISSUE_LABEL,
  parseMoneyInput,
  parsePercentInput,
  PROFIT_STATUS_LABEL,
  profitTone,
} from '../format';
import { Badge, Empty, ErrorText, Field, Loading, Panel, useAction, useAsync } from '../ui';

const Breakdown = ({ b }: { b: ProfitBreakdown }) => {
  const rows: [string, number][] = [
    ['Precio de venta', b.salePriceCents],
    ['Costo del proveedor', -b.supplierCostCents],
    ['Envío', -b.shippingCents],
    ['Comisiones', -b.commissionsCents],
    ['Costos de cobro', -b.paymentProcessingCents],
    ['Impuestos', -b.taxesCents],
    ['Retenciones', -b.withholdingsCents],
    ['Reserva de devoluciones', -b.returnReserveCents],
    ['Otros', -b.otherCostsCents],
  ];
  return (
    <table className="table breakdown">
      <tbody>
        {rows
          .filter(([, v], i) => i === 0 || v !== 0)
          .map(([label, v]) => (
            <tr key={label}>
              <td>{label}</td>
              <td className="num">{formatCents(v)}</td>
            </tr>
          ))}
        <tr className="total">
          <td>Beneficio neto</td>
          <td className={`num ${b.netProfitCents < 0 ? 'bad-text' : ''}`}>
            {formatCents(b.netProfitCents)}
          </td>
        </tr>
        <tr>
          <td>Margen neto (mínimo {formatBps(b.minMarginBps)})</td>
          <td className="num">{formatBps(b.marginBps)}</td>
        </tr>
      </tbody>
    </table>
  );
};

const Calculator = ({ onDone }: { onDone: () => void }) => {
  const products = useAsync(() => api.products.list(), 'all');
  const [productId, setProductId] = useState('');
  const offers = useAsync(
    () => (productId ? api.offers.list(productId) : Promise.resolve({ items: [] })),
    productId,
  );
  const [offerId, setOfferId] = useState('');
  const action = useAction();

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (await action.run(() => api.profit.calculate(productId, offerId))) onDone();
  };

  return (
    <form className="form inline-form" onSubmit={(e) => void submit(e)}>
      <Field label="Producto">
        <select
          required
          value={productId}
          onChange={(e) => {
            setProductId(e.target.value);
            setOfferId('');
          }}
        >
          <option value="">Elegir…</option>
          {products.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Oferta del proveedor">
        <select
          required
          value={offerId}
          disabled={!productId}
          onChange={(e) => {
            setOfferId(e.target.value);
          }}
        >
          <option value="">Elegir…</option>
          {offers.data?.items.map((o) => (
            <option key={o.id} value={o.id}>
              {o.supplierName} · {formatCents(o.wholesalePriceCents, o.currency)}
            </option>
          ))}
        </select>
      </Field>
      <button type="submit" disabled={action.busy || !offerId}>
        Calcular rentabilidad
      </button>
      <ErrorText>{action.error}</ErrorText>
    </form>
  );
};

const Simulator = () => {
  const action = useAction();
  const [form, setForm] = useState({
    price: '',
    cost: '',
    shipping: '',
    commission: '',
    processing: '',
    tax: '',
    withholding: '',
    returns: '',
  });
  const [result, setResult] = useState<ProfitBreakdown | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const price = parseMoneyInput(form.price);
    const cost = parseMoneyInput(form.cost);
    const shipping = form.shipping ? parseMoneyInput(form.shipping) : 0;
    const rates = (['commission', 'processing', 'tax', 'withholding', 'returns'] as const).map(
      (k) => (form[k] ? parsePercentInput(form[k]) : 0),
    );
    if (price === null || cost === null || shipping === null || rates.some((r) => r === null)) {
      action.setError('Revisá los valores: montos como 12.345,67 y porcentajes como 13 o 4,99.');
      return;
    }
    const [commission, processing, tax, withholding, returns] = rates as number[];
    await action.run(async () => {
      setResult(
        await api.profit.simulate({
          salePriceCents: price,
          supplierCostCents: cost,
          components: [
            { kind: 'SHIPPING', name: 'Envío', fixedCents: shipping },
            { kind: 'CHANNEL_COMMISSION', name: 'Comisión', rateBps: commission ?? 0 },
            { kind: 'PAYMENT_PROCESSING', name: 'Cobro', rateBps: processing ?? 0 },
            { kind: 'TAX', name: 'Impuestos', rateBps: tax ?? 0 },
            { kind: 'WITHHOLDING', name: 'Retenciones', rateBps: withholding ?? 0 },
            { kind: 'RETURN_RESERVE', name: 'Reserva devoluciones', rateBps: returns ?? 0 },
          ],
        }),
      );
    }, false);
  };

  return (
    <>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <div className="grid">
          <Field label="Precio de venta">
            <input required inputMode="decimal" value={form.price} onChange={set('price')} />
          </Field>
          <Field label="Costo del proveedor">
            <input required inputMode="decimal" value={form.cost} onChange={set('cost')} />
          </Field>
          <Field label="Envío">
            <input inputMode="decimal" value={form.shipping} onChange={set('shipping')} />
          </Field>
          <Field label="Comisión del canal %">
            <input inputMode="decimal" value={form.commission} onChange={set('commission')} />
          </Field>
          <Field label="Costo de cobro %">
            <input inputMode="decimal" value={form.processing} onChange={set('processing')} />
          </Field>
          <Field label="Impuestos %">
            <input inputMode="decimal" value={form.tax} onChange={set('tax')} />
          </Field>
          <Field label="Retenciones %">
            <input inputMode="decimal" value={form.withholding} onChange={set('withholding')} />
          </Field>
          <Field label="Reserva devoluciones %">
            <input inputMode="decimal" value={form.returns} onChange={set('returns')} />
          </Field>
        </div>
        <button type="submit" disabled={action.busy}>
          Simular
        </button>
        <ErrorText>{action.error}</ErrorText>
      </form>
      {result && (
        <div className="result">
          <Badge tone={profitTone(result.status)}>{PROFIT_STATUS_LABEL[result.status]}</Badge>
          <Breakdown b={result} />
        </div>
      )}
    </>
  );
};

const toIso = (local: string) => new Date(local).toISOString();

const FinancialGuardForm = () => {
  const action = useAction();
  const [form, setForm] = useState({
    funds: '',
    fundsAsOf: '',
    costs: '',
    settlement: '',
    settlementDate: '',
    supplierDue: '',
    returnRisk: '',
    financing: false,
    finLimit: '',
    finCost: '',
    finTerm: '',
  });
  const [result, setResult] = useState<FinancialGuardResult | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const funds = parseMoneyInput(form.funds);
    const costs = parseMoneyInput(form.costs);
    const settlement = parseMoneyInput(form.settlement);
    const risk = parsePercentInput(form.returnRisk);
    const finLimit = form.financing ? parseMoneyInput(form.finLimit) : 0;
    const finCost = form.financing ? parsePercentInput(form.finCost) : 0;
    if ([funds, costs, settlement, risk, finLimit, finCost].some((v) => v === null)) {
      action.setError('Completá todos los montos y porcentajes con valores válidos.');
      return;
    }
    await action.run(async () => {
      setResult(
        await api.profit.financialGuard({
          availableFundsCents: funds ?? 0,
          fundsAsOf: toIso(form.fundsAsOf),
          fundsSource: 'MANUAL',
          totalCostsCents: costs ?? 0,
          expectedSettlementCents: settlement ?? 0,
          channelSettlementDate: toIso(form.settlementDate),
          supplierPaymentDueDate: toIso(form.supplierDue),
          returnRiskBps: risk ?? 0,
          financing: form.financing
            ? {
                available: true,
                limitCents: finLimit ?? 0,
                costBps: finCost ?? 0,
                termDays: Number(form.finTerm),
                source: 'MANUAL',
              }
            : null,
        }),
      );
    });
  };

  return (
    <>
      <p className="muted">
        Cargá datos reales de tu cuenta: no hay valores por defecto. Si el proveedor cobra antes de
        que el canal liquide y no hay fondos ni financiación suficiente, la operación se bloquea.
      </p>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <div className="grid">
          <Field label="Fondos disponibles">
            <input required inputMode="decimal" value={form.funds} onChange={set('funds')} />
          </Field>
          <Field label="Fondos al (fecha y hora)">
            <input
              required
              type="datetime-local"
              value={form.fundsAsOf}
              onChange={set('fundsAsOf')}
            />
          </Field>
          <Field label="Costos totales de la operación">
            <input required inputMode="decimal" value={form.costs} onChange={set('costs')} />
          </Field>
          <Field label="Liquidación neta esperada">
            <input
              required
              inputMode="decimal"
              value={form.settlement}
              onChange={set('settlement')}
            />
          </Field>
          <Field label="Fecha de liquidación del canal">
            <input
              required
              type="datetime-local"
              value={form.settlementDate}
              onChange={set('settlementDate')}
            />
          </Field>
          <Field label="Vencimiento del pago al proveedor">
            <input
              required
              type="datetime-local"
              value={form.supplierDue}
              onChange={set('supplierDue')}
            />
          </Field>
          <Field label="Riesgo de devolución %">
            <input
              required
              inputMode="decimal"
              value={form.returnRisk}
              onChange={set('returnRisk')}
            />
          </Field>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={form.financing}
            onChange={(e) => {
              setForm((f) => ({ ...f, financing: e.target.checked }));
            }}
          />
          Tengo financiación disponible
        </label>
        {form.financing && (
          <div className="grid">
            <Field label="Límite de financiación">
              <input
                required
                inputMode="decimal"
                value={form.finLimit}
                onChange={set('finLimit')}
              />
            </Field>
            <Field label="Costo de financiación %">
              <input required inputMode="decimal" value={form.finCost} onChange={set('finCost')} />
            </Field>
            <Field label="Plazo (días)">
              <input
                required
                type="number"
                min={1}
                value={form.finTerm}
                onChange={set('finTerm')}
              />
            </Field>
          </div>
        )}
        <button type="submit" disabled={action.busy}>
          Evaluar operación
        </button>
        <ErrorText>{action.error}</ErrorText>
      </form>
      {result && (
        <div className="result">
          <Badge tone={result.decision === 'APPROVED' ? 'good' : 'bad'}>
            {result.decision === 'APPROVED' ? 'Aprobada' : 'Bloqueada'}
          </Badge>
          {result.issues.length > 0 && (
            <ul className="issues">
              {result.issues.map((i) => (
                <li key={i}>{ISSUE_LABEL[i]}</li>
              ))}
            </ul>
          )}
          <dl className="stats">
            <div>
              <dt>Brecha de fondos</dt>
              <dd>{result.fundingGapDays} días</dd>
            </div>
            <div>
              <dt>Fondos requeridos</dt>
              <dd>{formatCents(result.requiredFundsCents)}</dd>
            </div>
            <div>
              <dt>Reserva devoluciones</dt>
              <dd>{formatCents(result.returnReserveCents)}</dd>
            </div>
            <div>
              <dt>Financiación usada</dt>
              <dd>{formatCents(result.financingUsedCents)}</dd>
            </div>
            <div>
              <dt>Resultado proyectado</dt>
              <dd>{formatCents(result.projectedProfitCents)}</dd>
            </div>
          </dl>
        </div>
      )}
    </>
  );
};

export const ProfitabilitySection = () => {
  const calcs = useAsync(() => api.profit.list(), 'all');
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="stack">
      <Panel title="Rentabilidad por producto">
        <Calculator onDone={calcs.reload} />
        {calcs.error && <ErrorText>{calcs.error}</ErrorText>}
        {calcs.loading && !calcs.data ? (
          <Loading />
        ) : calcs.data?.items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Resultado</th>
                  <th className="num">Beneficio neto</th>
                  <th className="num">Margen</th>
                  <th>Motivos</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {calcs.data.items.map((c) => (
                  <Fragment key={c.id}>
                    <tr
                      onClick={() => {
                        setExpanded(expanded === c.id ? null : c.id);
                      }}
                      tabIndex={0}
                    >
                      <td>{c.productTitle}</td>
                      <td>
                        <Badge tone={profitTone(c.status)}>{PROFIT_STATUS_LABEL[c.status]}</Badge>
                      </td>
                      <td className="num">
                        {c.breakdown ? formatCents(c.breakdown.netProfitCents, c.currency) : '—'}
                      </td>
                      <td className="num">
                        {c.breakdown ? formatBps(c.breakdown.marginBps) : '—'}
                      </td>
                      <td className="small">
                        {c.issues.map((i) => ISSUE_LABEL[i]).join(' · ') || '—'}
                      </td>
                      <td className="small">{formatDateTime(c.calculatedAt)}</td>
                    </tr>
                    {expanded === c.id && c.breakdown && (
                      <tr className="row-editor">
                        <td colSpan={6}>
                          <Breakdown b={c.breakdown} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Sin cálculos todavía. Elegí un producto y una oferta.</Empty>
        )}
      </Panel>
      <div className="split">
        <Panel title="Simulador (sin guardar)">
          <Simulator />
        </Panel>
        <Panel title="Financial Guard">
          <FinancialGuardForm />
        </Panel>
      </div>
    </div>
  );
};

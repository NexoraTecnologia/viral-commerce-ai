import { useState, type SubmitEvent } from 'react';
import type { CostComponentKind, Currency, DataSource } from '@vc/shared';
import { api } from '../api-client';
import {
  formatBps,
  formatCents,
  formatDateTime,
  parseMoneyInput,
  parsePercentInput,
  SUPPLIER_STATUS_LABEL,
} from '../format';
import { Empty, ErrorText, Field, Loading, Panel, useAction, useAsync } from '../ui';

export const COST_KIND_LABEL: Record<CostComponentKind, string> = {
  SHIPPING: 'Envío',
  CHANNEL_COMMISSION: 'Comisión del canal',
  PAYMENT_PROCESSING: 'Costo de cobro',
  TAX: 'Impuesto',
  WITHHOLDING: 'Retención',
  RETURN_RESERVE: 'Reserva de devoluciones',
  OTHER: 'Otro',
};

const ProductForm = ({ onCreated }: { onCreated: () => void }) => {
  const action = useAction();
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState<Currency>('ARS');

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const cents = parseMoneyInput(price);
    if (cents === null || cents <= 0) {
      action.setError('Precio inválido. Ejemplo: 25.999,90');
      return;
    }
    if (await action.run(() => api.products.create({ title, salePriceCents: cents, currency }))) {
      setTitle('');
      setPrice('');
      onCreated();
    }
  };

  return (
    <form className="form inline-form" onSubmit={(e) => void submit(e)}>
      <Field label="Producto">
        <input
          required
          minLength={2}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
          }}
        />
      </Field>
      <Field label="Precio de venta">
        <input
          required
          inputMode="decimal"
          placeholder="25.999,90"
          value={price}
          onChange={(e) => {
            setPrice(e.target.value);
          }}
        />
      </Field>
      <Field label="Moneda">
        <select
          value={currency}
          onChange={(e) => {
            setCurrency(e.target.value as Currency);
          }}
        >
          <option value="ARS">ARS</option>
          <option value="USD">USD</option>
        </select>
      </Field>
      <button type="submit" disabled={action.busy}>
        Crear producto
      </button>
      <ErrorText>{action.error}</ErrorText>
    </form>
  );
};

const CostsEditor = ({ productId, currency }: { productId: string; currency: Currency }) => {
  const costs = useAsync(() => api.products.costs(productId), productId);
  const action = useAction();
  const [form, setForm] = useState({
    kind: 'SHIPPING' as CostComponentKind,
    name: '',
    fixed: '',
    rate: '',
  });

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const fixed = form.fixed.trim() ? parseMoneyInput(form.fixed) : undefined;
    const rate = form.rate.trim() ? parsePercentInput(form.rate) : undefined;
    if (fixed === null || rate === null || (fixed === undefined && rate === undefined)) {
      action.setError('Indicá un monto fijo, un porcentaje o ambos (valores válidos).');
      return;
    }
    const ok = await action.run(() =>
      api.products.addCost(productId, {
        kind: form.kind,
        name: form.name || COST_KIND_LABEL[form.kind],
        ...(fixed === undefined ? {} : { fixedCents: fixed }),
        ...(rate === undefined ? {} : { rateBps: rate }),
      }),
    );
    if (ok) {
      setForm((f) => ({ ...f, name: '', fixed: '', rate: '' }));
      costs.reload();
    }
  };

  const remove = async (costId: string) => {
    if (await action.run(() => api.products.deleteCost(productId, costId))) costs.reload();
  };

  return (
    <>
      <h4>Costos configurados</h4>
      {costs.loading && !costs.data ? (
        <Loading />
      ) : costs.data?.items.length ? (
        <ul className="list compact">
          {costs.data.items.map((c) => (
            <li key={c.id}>
              <span>
                <strong>{COST_KIND_LABEL[c.kind]}</strong> · {c.name}:{' '}
                {[
                  c.fixedCents !== null ? formatCents(c.fixedCents, currency) : null,
                  c.rateBps !== null ? `${formatBps(c.rateBps)} del precio` : null,
                ]
                  .filter(Boolean)
                  .join(' + ')}
              </span>
              <button
                type="button"
                className="ghost danger"
                disabled={action.busy}
                onClick={() => void remove(c.id)}
              >
                Quitar
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>
          Sin costos. Cargá envío, comisiones, impuestos, retenciones, cobro y reserva de
          devoluciones.
        </Empty>
      )}
      <form className="form inline-form" onSubmit={(e) => void submit(e)}>
        <Field label="Tipo">
          <select
            value={form.kind}
            onChange={(e) => {
              setForm((f) => ({ ...f, kind: e.target.value as CostComponentKind }));
            }}
          >
            {(Object.keys(COST_KIND_LABEL) as CostComponentKind[]).map((k) => (
              <option key={k} value={k}>
                {COST_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Nombre">
          <input
            value={form.name}
            placeholder={COST_KIND_LABEL[form.kind]}
            onChange={(e) => {
              setForm((f) => ({ ...f, name: e.target.value }));
            }}
          />
        </Field>
        <Field label="Monto fijo">
          <input
            inputMode="decimal"
            value={form.fixed}
            onChange={(e) => {
              setForm((f) => ({ ...f, fixed: e.target.value }));
            }}
          />
        </Field>
        <Field label="% sobre precio">
          <input
            inputMode="decimal"
            value={form.rate}
            onChange={(e) => {
              setForm((f) => ({ ...f, rate: e.target.value }));
            }}
          />
        </Field>
        <button type="submit" disabled={action.busy}>
          Agregar costo
        </button>
      </form>
      <ErrorText>{action.error}</ErrorText>
    </>
  );
};

const OffersEditor = ({ productId, currency }: { productId: string; currency: Currency }) => {
  const offers = useAsync(() => api.offers.list(productId), productId);
  const suppliers = useAsync(() => api.suppliers.list(), 'all');
  const action = useAction();
  const [form, setForm] = useState({
    supplierId: '',
    sku: '',
    title: '',
    price: '',
    source: 'MANUAL' as DataSource,
  });

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const cents = parseMoneyInput(form.price);
    if (cents === null) {
      action.setError('Precio mayorista inválido.');
      return;
    }
    const ok = await action.run(() =>
      api.offers.create({
        supplierId: form.supplierId,
        productId,
        supplierSku: form.sku,
        title: form.title,
        wholesalePriceCents: cents,
        currency,
        priceSource: form.source,
        minOrderQty: 1,
      }),
    );
    if (ok) {
      setForm((f) => ({ ...f, sku: '', title: '', price: '' }));
      offers.reload();
    }
  };

  return (
    <>
      <h4>Ofertas de proveedores</h4>
      {offers.data?.items.length ? (
        <ul className="list compact">
          {offers.data.items.map((o) => (
            <li key={o.id}>
              <span>
                <strong>{o.supplierName}</strong> · {o.supplierSku} ·{' '}
                {formatCents(o.wholesalePriceCents, o.currency)}
                <div className="muted small">
                  {SUPPLIER_STATUS_LABEL[o.supplierStatus as keyof typeof SUPPLIER_STATUS_LABEL]} ·
                  precio del {formatDateTime(o.priceUpdatedAt)}
                </div>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Sin ofertas vinculadas.</Empty>
      )}
      <form className="form inline-form" onSubmit={(e) => void submit(e)}>
        <Field label="Proveedor">
          <select
            required
            value={form.supplierId}
            onChange={(e) => {
              setForm((f) => ({ ...f, supplierId: e.target.value }));
            }}
          >
            <option value="">Elegir…</option>
            {suppliers.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.legalName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="SKU del proveedor">
          <input
            required
            value={form.sku}
            onChange={(e) => {
              setForm((f) => ({ ...f, sku: e.target.value }));
            }}
          />
        </Field>
        <Field label="Título en catálogo">
          <input
            required
            minLength={2}
            value={form.title}
            onChange={(e) => {
              setForm((f) => ({ ...f, title: e.target.value }));
            }}
          />
        </Field>
        <Field label={`Precio mayorista (${currency})`}>
          <input
            required
            inputMode="decimal"
            value={form.price}
            onChange={(e) => {
              setForm((f) => ({ ...f, price: e.target.value }));
            }}
          />
        </Field>
        <Field label="Origen del precio">
          <select
            value={form.source}
            onChange={(e) => {
              setForm((f) => ({ ...f, source: e.target.value as DataSource }));
            }}
          >
            <option value="MANUAL">Carga manual</option>
            <option value="SUPPLIER_REPORT">Informado por el proveedor</option>
          </select>
        </Field>
        <button type="submit" disabled={action.busy}>
          Agregar oferta
        </button>
      </form>
      <ErrorText>{action.error}</ErrorText>
    </>
  );
};

export const ProductsSection = () => {
  const products = useAsync(() => api.products.list(), 'all');
  const [selected, setSelected] = useState<string | null>(null);
  const product = products.data?.items.find((p) => p.id === selected);

  return (
    <div className="split">
      <Panel title="Productos">
        <ProductForm onCreated={products.reload} />
        {products.error && <ErrorText>{products.error}</ErrorText>}
        {products.loading && !products.data ? (
          <Loading />
        ) : products.data?.items.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Precio de venta</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {products.data.items.map((p) => (
                <tr
                  key={p.id}
                  className={p.id === selected ? 'selected' : ''}
                  onClick={() => {
                    setSelected(p.id);
                  }}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setSelected(p.id);
                  }}
                >
                  <td>{p.title}</td>
                  <td className="num">{formatCents(p.salePriceCents, p.currency)}</td>
                  <td>{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Todavía no hay productos.</Empty>
        )}
      </Panel>
      <Panel title={product ? product.title : 'Detalle'}>
        {product ? (
          <div className="detail">
            <CostsEditor productId={product.id} currency={product.currency} />
            <OffersEditor productId={product.id} currency={product.currency} />
          </div>
        ) : (
          <Empty>Elegí un producto para configurar costos y ofertas.</Empty>
        )}
      </Panel>
    </div>
  );
};

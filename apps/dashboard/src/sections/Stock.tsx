import { useState, type SubmitEvent } from 'react';
import type { DataSource, StockStatus, SupplierProductDto } from '@vc/shared';
import { api } from '../api-client';
import {
  formatCents,
  formatDateTime,
  hoursSince,
  parseMoneyInput,
  STOCK_LABEL,
  stockTone,
} from '../format';
import { Badge, Empty, ErrorText, Field, Loading, Panel, useAction, useAsync } from '../ui';

const OfferRow = ({ offer, onChanged }: { offer: SupplierProductDto; onChanged: () => void }) => {
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [stock, setStock] = useState({
    status: 'IN_STOCK' as StockStatus,
    qty: '',
    source: 'SUPPLIER_REPORT' as DataSource,
  });
  const [price, setPrice] = useState('');
  const inv = offer.latestInventory;
  const stockAge = inv ? hoursSince(inv.checkedAt) : null;
  const priceAge = hoursSince(offer.priceUpdatedAt);

  const saveStock = async (e: SubmitEvent) => {
    e.preventDefault();
    const quantity = stock.qty.trim() ? Number(stock.qty) : undefined;
    const ok = await action.run(() =>
      api.offers.recordInventory(offer.id, {
        stockStatus: stock.status,
        source: stock.source,
        ...(quantity === undefined || stock.status === 'UNKNOWN' ? {} : { quantity }),
      }),
    );
    if (ok) {
      setOpen(false);
      onChanged();
    }
  };

  const savePrice = async (e: SubmitEvent) => {
    e.preventDefault();
    const cents = parseMoneyInput(price);
    if (cents === null) {
      action.setError('Precio inválido.');
      return;
    }
    if (
      await action.run(() =>
        api.offers.updatePrice(offer.id, { wholesalePriceCents: cents, priceSource: 'MANUAL' }),
      )
    ) {
      setPrice('');
      setOpen(false);
      onChanged();
    }
  };

  return (
    <>
      <tr>
        <td>
          {offer.title}
          <div className="muted small">
            {offer.supplierName} · {offer.supplierSku}
          </div>
        </td>
        <td>
          {inv ? (
            <Badge tone={stockTone(inv.stockStatus)}>{STOCK_LABEL[inv.stockStatus]}</Badge>
          ) : (
            <Badge tone="neutral">Sin control</Badge>
          )}
          {inv?.quantity !== null && inv?.quantity !== undefined && (
            <span className="muted small"> · {inv.quantity} u.</span>
          )}
        </td>
        <td className={stockAge !== null && stockAge > 24 ? 'warn-text' : ''}>
          {inv ? `${formatDateTime(inv.checkedAt)} (${stockAge} h)` : '—'}
        </td>
        <td className="num">{formatCents(offer.wholesalePriceCents, offer.currency)}</td>
        <td className={priceAge > 72 ? 'warn-text' : ''}>{priceAge} h</td>
        <td>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setOpen((o) => !o);
            }}
          >
            {open ? 'Cerrar' : 'Actualizar'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="row-editor">
          <td colSpan={6}>
            <form className="form inline-form" onSubmit={(e) => void saveStock(e)}>
              <Field label="Stock">
                <select
                  value={stock.status}
                  onChange={(e) => {
                    setStock((s) => ({ ...s, status: e.target.value as StockStatus }));
                  }}
                >
                  {(Object.keys(STOCK_LABEL) as StockStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {STOCK_LABEL[s]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Cantidad">
                <input
                  type="number"
                  min={0}
                  disabled={stock.status === 'UNKNOWN'}
                  value={stock.qty}
                  onChange={(e) => {
                    setStock((s) => ({ ...s, qty: e.target.value }));
                  }}
                />
              </Field>
              <Field label="Origen">
                <select
                  value={stock.source}
                  onChange={(e) => {
                    setStock((s) => ({ ...s, source: e.target.value as DataSource }));
                  }}
                >
                  <option value="SUPPLIER_REPORT">Informado por el proveedor</option>
                  <option value="MANUAL">Control manual</option>
                </select>
              </Field>
              <button type="submit" disabled={action.busy}>
                Registrar control
              </button>
            </form>
            <form className="form inline-form" onSubmit={(e) => void savePrice(e)}>
              <Field label={`Nuevo precio mayorista (${offer.currency})`}>
                <input
                  inputMode="decimal"
                  required
                  value={price}
                  onChange={(e) => {
                    setPrice(e.target.value);
                  }}
                />
              </Field>
              <button type="submit" disabled={action.busy}>
                Actualizar precio
              </button>
            </form>
            <ErrorText>{action.error}</ErrorText>
          </td>
        </tr>
      )}
    </>
  );
};

export const StockSection = () => {
  const offers = useAsync(() => api.offers.list(), 'all');
  return (
    <Panel title="Stock y precios de proveedores">
      <p className="muted">
        Sin integraciones: los controles se cargan a mano o según lo informa el proveedor. Un stock
        sin control, desconocido o viejo bloquea la operación del producto.
      </p>
      {offers.error && <ErrorText>{offers.error}</ErrorText>}
      {offers.loading && !offers.data ? (
        <Loading />
      ) : offers.data?.items.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Oferta</th>
                <th>Stock</th>
                <th>Último control</th>
                <th className="num">Precio mayorista</th>
                <th>Antigüedad del precio</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {offers.data.items.map((o) => (
                <OfferRow key={o.id} offer={o} onChanged={offers.reload} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No hay ofertas de proveedores. Agregalas desde Productos.</Empty>
      )}
    </Panel>
  );
};

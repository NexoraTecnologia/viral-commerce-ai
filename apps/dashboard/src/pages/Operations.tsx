import { useState } from 'react';
import type { ShipmentStatus } from '@vc/shared';
import { api } from '../api-client';
import { formatCents, formatDateTime } from '../format';
import { MessagesView } from '../sections/Channels';
import { STATE_LABEL, stateTone, SupportView } from '../sections/Orders';
import {
  AsyncView,
  Badge,
  ControlsPager,
  EmptyState,
  ListToolbar,
  PageHeader,
  Panel,
  SubTabs,
  useAsync,
  useListControls,
} from '../ui';

/* ================================ Envíos ================================ */

const SHIP_LABEL: Record<ShipmentStatus, string> = {
  SHIPPED: 'En tránsito',
  DELAYED: 'Demorado (informado)',
  DELIVERED: 'Entregado',
  RETURNED: 'Devuelto',
};

export const ShipmentsPage = () => {
  const data = useAsync(() => api.command.shipments(), 'shipments');
  const c = useListControls(data.data?.items, {
    text: (s) => `${String(s.orderNumber)} ${s.carrier} ${s.trackingNumber}`,
    filter: (s, v) => (v === 'OVERDUE' ? s.overdue : s.status === v),
  });
  return (
    <div className="stack">
      <PageHeader
        title="Envíos"
        description="Solo envíos registrados con transportista, número de seguimiento y comprobante. Un envío vencido es el que superó la fecha estimada sin entrega confirmada."
        actions={
          <button type="button" className="ghost" onClick={data.reload}>
            Actualizar
          </button>
        }
      />
      <Panel title="Seguimiento">
        <ListToolbar
          controls={c}
          placeholder="Buscar por pedido, transportista o seguimiento"
          filterLabel="Todos los estados"
          filterOptions={[
            ...(Object.keys(SHIP_LABEL) as ShipmentStatus[]).map((k) => ({
              value: k,
              label: SHIP_LABEL[k],
            })),
            { value: 'OVERDUE', label: 'Vencidos sin entrega' },
          ]}
        />
        <AsyncView
          state={data}
          isEmpty={() => c.filteredCount === 0}
          empty={
            <EmptyState title={c.totalCount === 0 ? 'Sin envíos registrados' : 'Sin resultados'}>
              {c.totalCount === 0
                ? 'Los envíos aparecen cuando un pedido aceptado por el proveedor se despacha con comprobante.'
                : 'Probá con otra búsqueda o filtro.'}
            </EmptyState>
          }
        >
          {() => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Pedido</th>
                    <th>Transportista</th>
                    <th>Seguimiento</th>
                    <th>Estado</th>
                    <th>Despachado</th>
                    <th>Entrega estimada</th>
                  </tr>
                </thead>
                <tbody>
                  {c.pageItems.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <a href="#pedidos">#{s.orderNumber}</a>
                        <div>
                          <Badge tone={stateTone(s.orderState)}>{STATE_LABEL[s.orderState]}</Badge>
                        </div>
                      </td>
                      <td>{s.carrier}</td>
                      <td>
                        {s.trackingUrl ? (
                          <a href={s.trackingUrl} target="_blank" rel="noopener noreferrer">
                            {s.trackingNumber}
                          </a>
                        ) : (
                          <code>{s.trackingNumber}</code>
                        )}
                      </td>
                      <td>
                        <Badge
                          tone={
                            s.status === 'DELIVERED'
                              ? 'good'
                              : s.overdue || s.status === 'DELAYED'
                                ? 'bad'
                                : 'neutral'
                          }
                        >
                          {SHIP_LABEL[s.status]}
                        </Badge>
                        {s.overdue && <div className="small bad-text">Vencido sin entrega</div>}
                      </td>
                      <td>{formatDateTime(s.shippedAt)}</td>
                      <td>
                        {s.deliveredAt
                          ? `Entregado ${formatDateTime(s.deliveredAt)}`
                          : s.estimatedDeliveryAt
                            ? formatDateTime(s.estimatedDeliveryAt)
                            : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncView>
        <ControlsPager controls={c} />
      </Panel>
    </div>
  );
};

/* ================================ Clientes ================================ */

const CustomersList = () => {
  const data = useAsync(() => api.command.customers(), 'customers');
  const c = useListControls(data.data?.items, {
    text: (x) => x.buyerRef,
    filter: (x, v) => (v === 'OPEN' ? x.openOrders > 0 : x.orders > 1),
  });
  return (
    <Panel title="Compradores">
      <p className="muted small">
        Compradores de pedidos registrados, identificados por su referencia (sin datos personales).
        El total pagado incluye solo cobros con evidencia, netos de reembolsos.
      </p>
      <ListToolbar
        controls={c}
        placeholder="Buscar comprador"
        filterLabel="Todos"
        filterOptions={[
          { value: 'OPEN', label: 'Con pedidos abiertos' },
          { value: 'REPEAT', label: 'Recurrentes (2+ pedidos)' },
        ]}
      />
      <AsyncView
        state={data}
        isEmpty={() => c.filteredCount === 0}
        empty={
          <EmptyState title={c.totalCount === 0 ? 'Sin compradores todavía' : 'Sin resultados'}>
            Aparecen al recibir pedidos.
          </EmptyState>
        }
      >
        {() => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Comprador</th>
                  <th className="num">Pedidos</th>
                  <th className="num">Abiertos</th>
                  <th className="num">Pagado</th>
                  <th>Último pedido</th>
                </tr>
              </thead>
              <tbody>
                {c.pageItems.map((x) => (
                  <tr key={x.buyerRef}>
                    <td>{x.buyerRef}</td>
                    <td className="num">{x.orders}</td>
                    <td className="num">{x.openOrders}</td>
                    <td className="num">
                      {x.paid.length
                        ? x.paid.map((p) => formatCents(p.cents, p.currency)).join(' · ')
                        : '—'}
                    </td>
                    <td>
                      #{x.lastOrderNumber} · {formatDateTime(x.lastOrderAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncView>
      <ControlsPager controls={c} />
    </Panel>
  );
};

export const CustomersPage = () => {
  const [view, setView] = useState('compradores');
  return (
    <div className="stack">
      <PageHeader
        title="Clientes"
        description="Compradores, consultas de atención al cliente y mensajes de los canales."
      />
      <SubTabs
        value={view}
        onChange={setView}
        label="Clientes"
        options={[
          { id: 'compradores', label: 'Compradores' },
          { id: 'atencion', label: 'Atención al cliente' },
          { id: 'mensajes', label: 'Mensajes de canales' },
        ]}
      />
      {view === 'compradores' && <CustomersList />}
      {view === 'atencion' && <SupportView />}
      {view === 'mensajes' && <MessagesView />}
    </div>
  );
};

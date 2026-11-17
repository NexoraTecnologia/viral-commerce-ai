import type { OverviewDto } from '@vc/shared';
import { api } from '../api-client';
import { formatCents, formatDateTime } from '../format';
import { AsyncView, Badge, Kpi, PageHeader, Panel, useAsync } from '../ui';

const money = (rows: OverviewDto['sales']['total']) =>
  rows.length === 0 ? null : rows.map((r) => formatCents(r.cents, r.currency)).join(' · ');

const n = (v: number) => new Intl.NumberFormat('es-AR').format(v);

const FreeTier = ({ rows }: { rows: OverviewDto['freeTier'] }) => (
  <div className="table-wrap">
    <table className="table">
      <thead>
        <tr>
          <th>Recurso (plan gratuito)</th>
          <th className="num">Uso</th>
          <th className="num">Límite</th>
          <th style={{ minWidth: 140 }}>Consumo</th>
          <th>Cómo se mide</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const pct = r.used === null ? null : Math.min(100, (r.used / r.limit) * 100);
          return (
            <tr key={r.resource}>
              <td>{r.resource}</td>
              <td className="num">{r.used === null ? '—' : n(r.used)}</td>
              <td className="num">
                {n(r.limit)} <span className="muted small">{r.unit}</span>
              </td>
              <td>
                {pct === null ? (
                  <Badge tone="neutral">No medido</Badge>
                ) : (
                  <div
                    className={pct >= 80 ? 'progress bad' : 'progress'}
                    title={`${pct.toFixed(1)} %`}
                  >
                    <span style={{ width: `${Math.max(pct, 1)}%` }} />
                  </div>
                )}
              </td>
              <td className="small muted">
                {r.note}
                <div>
                  Fuente: <code>{r.source}</code>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

export const OverviewPage = () => {
  const data = useAsync(() => api.command.overview(), 'overview');
  return (
    <div className="stack">
      <PageHeader
        title="Overview"
        description="Indicadores calculados con datos reales registrados. Lo que no tiene datos se muestra como —; nunca se completa con ejemplos."
        actions={
          <button type="button" className="ghost" onClick={data.reload}>
            Actualizar
          </button>
        }
      />
      <AsyncView state={data} empty={null}>
        {(o) => (
          <>
            {!o.commercialActionsEnabled && (
              <p className="notice">
                Modo simulación: las acciones comerciales reales (publicar, comprar, cobrar,
                reembolsar, contactar) están bloqueadas.
              </p>
            )}
            <div className="kpi-grid">
              <Kpi
                label="Ventas reales (30 días)"
                value={money(o.sales.last30d)}
                sub={`Total ${money(o.sales.total) ?? '—'} · ${o.sales.paidOrders} pedido(s) cobrados con evidencia`}
                tone="good"
                href="#finanzas"
              />
              <Kpi
                label="Beneficio neto conciliado"
                value={money(o.netProfit.net)}
                sub={`${o.netProfit.settledOrders} pedido(s) conciliados`}
                tone="good"
                href="#finanzas"
              />
              <Kpi
                label="Productos investigados"
                value={n(o.discovery.researching)}
                sub={`${o.discovery.discarded} descartados`}
                href="#radar"
              />
              <Kpi
                label="Productos aprobados"
                value={n(o.discovery.candidates)}
                sub="Candidatos aprobados por Risk Guardian"
                tone="good"
                href="#radar"
              />
              <Kpi
                label="Publicaciones activas"
                value={n(o.listings.publishedLive)}
                sub={`${o.listings.publishedMock} simuladas (MOCK) · ${o.listings.ready} listas · ${o.listings.blocked} bloqueadas`}
                href="#publicaciones"
              />
              <Kpi
                label="Proveedores verificados"
                value={`${n(o.suppliers.verified)} / ${n(o.suppliers.total)}`}
                tone="good"
                href="#proveedores"
              />
              <Kpi
                label="Pedidos pendientes"
                value={n(o.orders.pending)}
                sub={`${o.orders.blocked} bloqueados · ${o.orders.manualReview} en revisión`}
                tone={o.orders.blocked + o.orders.manualReview > 0 ? 'bad' : undefined}
                href="#pedidos"
              />
              <Kpi
                label="Envíos pendientes"
                value={n(o.shipments.awaitingDispatch + o.shipments.inTransit)}
                sub={`${o.shipments.awaitingDispatch} por despachar · ${o.shipments.inTransit} en tránsito · ${o.shipments.delayed} demorados`}
                tone={o.shipments.delayed > 0 ? 'bad' : undefined}
                href="#envios"
              />
              <Kpi
                label="Trabajos automáticos (24 h)"
                value={n(o.jobs24h.completed)}
                sub={`completados · ${o.jobs24h.active} activos · ${o.jobs24h.failed + o.jobs24h.deadLetter} fallidos`}
                href="#automatizaciones"
              />
              <Kpi
                label="Errores (24 h)"
                value={n(o.errors24h.total)}
                sub={`${o.errors24h.jobFailures} trabajos · ${o.errors24h.integrationErrors} integraciones · ${o.errors24h.webhookProblems} webhooks`}
                tone={o.errors24h.total > 0 ? 'bad' : 'good'}
                href="#auditoria"
              />
            </div>
            <Panel title="Uso de recursos gratuitos (Cloudflare Free)">
              <FreeTier rows={o.freeTier} />
            </Panel>
            <p className="muted small">Actualizado {formatDateTime(o.generatedAt)}</p>
          </>
        )}
      </AsyncView>
    </div>
  );
};

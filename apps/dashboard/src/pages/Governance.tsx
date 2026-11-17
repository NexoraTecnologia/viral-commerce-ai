import { useState, type SubmitEvent } from 'react';
import type { JobCategory, RuleDto } from '@vc/shared';
import { api } from '../api-client';
import { formatCents, formatDateTime } from '../format';
import { FundsView, STATE_LABEL, stateTone } from '../sections/Orders';
import { ProfitabilitySection } from '../sections/Profitability';
import {
  AsyncView,
  Badge,
  ControlsPager,
  EmptyState,
  ErrorText,
  Field,
  Kpi,
  ListToolbar,
  PageHeader,
  Pager,
  Panel,
  SubTabs,
  useAction,
  useAsync,
  useListControls,
} from '../ui';

/* ================================ Agentes ================================ */

const CATEGORY_LABEL: Record<JobCategory, string> = {
  COMMERCIAL: 'Comercial',
  MAINTENANCE: 'Mantenimiento',
  SYSTEM: 'Sistema',
};

/** Agentes que no requieren parámetros: se pueden ejecutar a demanda. */
const RUNNABLE = new Set([
  'system.ping',
  'inventory.stale_scan',
  'supplier.evidence_expiry_scan',
  'discovery.rescore',
  'channels.connection_check',
  'channels.auto_publish',
  'orders.supplier_timeout_scan',
  'orders.reevaluate',
]);

export const AgentsPage = () => {
  const types = useAsync(() => api.automation.jobTypes(), 'agent-types');
  const jobs = useAsync(() => api.automation.jobs(), 'agent-jobs');
  const action = useAction();
  const c = useListControls(types.data?.items, {
    text: (t) => `${t.type} ${t.description}`,
    filter: (t, v) => t.category === v,
    pageSize: 12,
  });
  const last = (type: string) => jobs.data?.items.find((j) => j.type === type);
  return (
    <div className="stack">
      <PageHeader
        title="Agentes"
        description="Tipos de trabajo registrados en el Automation Core. Ninguno compra, publica, cobra ni contacta a terceros sin pasar por el Commercial Guard."
        actions={
          <a className="button" href="#automatizaciones">
            Programar frecuencias
          </a>
        }
      />
      <Panel title="Agentes registrados">
        <ListToolbar
          controls={c}
          placeholder="Buscar agente"
          filterLabel="Todas las categorías"
          filterOptions={(Object.keys(CATEGORY_LABEL) as JobCategory[]).map((k) => ({
            value: k,
            label: CATEGORY_LABEL[k],
          }))}
        />
        <AsyncView
          state={types}
          isEmpty={() => c.filteredCount === 0}
          empty={<EmptyState title="Sin resultados" />}
        >
          {() => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Agente</th>
                    <th>Categoría</th>
                    <th>Última ejecución</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {c.pageItems.map((t) => {
                    const j = last(t.type);
                    return (
                      <tr key={t.type}>
                        <td>
                          <code>{t.type}</code>
                          <div className="small muted">{t.description}</div>
                        </td>
                        <td>
                          <Badge tone={t.category === 'COMMERCIAL' ? 'warn' : 'neutral'}>
                            {CATEGORY_LABEL[t.category]}
                          </Badge>
                        </td>
                        <td className="small">
                          {j ? (
                            <>
                              <Badge
                                tone={
                                  j.status === 'COMPLETED'
                                    ? 'good'
                                    : j.status === 'FAILED' || j.status === 'DEAD_LETTER'
                                      ? 'bad'
                                      : 'neutral'
                                }
                              >
                                {j.status}
                              </Badge>{' '}
                              {formatDateTime(j.runAt)}
                            </>
                          ) : (
                            <span className="muted">Nunca</span>
                          )}
                        </td>
                        <td>
                          {RUNNABLE.has(t.type) ? (
                            <button
                              type="button"
                              className="ghost"
                              disabled={action.busy}
                              onClick={() =>
                                void action
                                  .run(
                                    () => api.automation.createJob({ type: t.type, payload: {} }),
                                    `Trabajo ${t.type} encolado`,
                                  )
                                  .then(jobs.reload)
                              }
                            >
                              Ejecutar ahora
                            </button>
                          ) : (
                            <span className="small muted">
                              Requiere parámetros: se dispara desde su módulo
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </AsyncView>
        <ControlsPager controls={c} />
        <ErrorText>{action.error}</ErrorText>
      </Panel>
    </div>
  );
};

/* ================================ Reglas ================================ */

export const RulesPage = () => {
  const rules = useAsync(() => api.command.rules(), 'rules');
  const requests = useAsync(() => api.command.ruleRequests(), 'rule-requests');
  const action = useAction();
  const [form, setForm] = useState({ ruleKey: '', proposedValue: '', reason: '' });
  const selected: RuleDto | undefined = rules.data?.items.find((r) => r.key === form.ruleKey);
  const propose = async (e: SubmitEvent) => {
    e.preventDefault();
    if (
      await action.run(
        () => api.command.proposeRule(form),
        'Propuesta registrada: queda pendiente de autorización del titular',
      )
    ) {
      setForm({ ruleKey: '', proposedValue: '', reason: '' });
      requests.reload();
    }
  };
  return (
    <div className="stack">
      <PageHeader
        title="Reglas"
        description="Reglas de decisión vigentes. El dashboard NO las modifica: registra propuestas que el titular autoriza cambiando la configuración del Worker y desplegando."
      />
      <Panel title="Reglas vigentes">
        <AsyncView
          state={rules}
          isEmpty={(d) => d.items.length === 0}
          empty={<EmptyState title="Sin reglas" />}
        >
          {(d) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Regla</th>
                    <th className="num">Valor</th>
                    <th>Tipo</th>
                    <th>Origen</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((r) => (
                    <tr key={r.key}>
                      <td>
                        <strong>{r.label}</strong>
                        <div className="small muted">{r.description}</div>
                        <code>{r.key}</code>
                      </td>
                      <td className="num">
                        {r.value} <div className="small muted">{r.unit}</div>
                      </td>
                      <td>
                        {r.financial ? (
                          <Badge tone="bad">Financiera · requiere autorización</Badge>
                        ) : (
                          <Badge tone="neutral">Operativa</Badge>
                        )}
                      </td>
                      <td className="small muted">{r.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncView>
      </Panel>
      <Panel title="Proponer un cambio">
        <form className="form inline-form" onSubmit={(e) => void propose(e)}>
          <Field label="Regla">
            <select
              value={form.ruleKey}
              onChange={(e) => {
                setForm({ ...form, ruleKey: e.target.value });
              }}
              required
            >
              <option value="">Elegir…</option>
              {rules.data?.items.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Valor propuesto"
            hint={selected ? `Actual: ${selected.value} (${selected.unit})` : undefined}
          >
            <input
              value={form.proposedValue}
              onChange={(e) => {
                setForm({ ...form, proposedValue: e.target.value });
              }}
              required
            />
          </Field>
          <Field label="Motivo" hint="Mínimo 10 caracteres">
            <input
              value={form.reason}
              onChange={(e) => {
                setForm({ ...form, reason: e.target.value });
              }}
              required
              minLength={10}
            />
          </Field>
          <button type="submit" disabled={action.busy}>
            Registrar propuesta
          </button>
        </form>
        {selected?.financial && (
          <p className="notice">
            Regla financiera: la propuesta no cambia nada hasta que el titular la autorice.
          </p>
        )}
        <ErrorText>{action.error}</ErrorText>
      </Panel>
      <Panel title="Propuestas">
        <AsyncView
          state={requests}
          isEmpty={(d) => d.items.length === 0}
          empty={<EmptyState title="Sin propuestas" />}
        >
          {(d) => (
            <ul className="list">
              {d.items.map((r) => (
                <li key={r.id}>
                  <span>
                    <code>{r.ruleKey}</code> {r.currentValue} → <strong>{r.proposedValue}</strong>
                    <span className="small muted">
                      {' '}
                      · {r.reason} · {formatDateTime(r.createdAt)}
                    </span>
                  </span>
                  <span className="row-actions">
                    <Badge tone={r.status === 'PENDING_AUTHORIZATION' ? 'warn' : 'neutral'}>
                      {r.status === 'PENDING_AUTHORIZATION'
                        ? 'Pendiente de autorización'
                        : 'Retirada'}
                    </Badge>
                    {r.status === 'PENDING_AUTHORIZATION' && (
                      <button
                        type="button"
                        disabled={action.busy}
                        onClick={() =>
                          void action
                            .run(() => api.command.withdrawRule(r.id), 'Propuesta retirada')
                            .then(requests.reload)
                        }
                      >
                        Retirar
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AsyncView>
      </Panel>
    </div>
  );
};

/* ================================ Auditoría ================================ */

export const AuditPage = () => {
  const [source, setSource] = useState<'SYSTEM' | 'ORDER'>('SYSTEM');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const pageSize = 25;
  const data = useAsync(
    () => api.command.audit({ source, page, pageSize, ...(applied ? { q: applied } : {}) }),
    `${source}:${String(page)}:${applied}`,
  );
  return (
    <div className="stack">
      <PageHeader
        title="Auditoría"
        description="Registro inmutable de acciones del sistema y de cada pedido. Paginado en el servidor."
      />
      <Panel title="Eventos">
        <form
          className="toolbar"
          onSubmit={(e: SubmitEvent) => {
            e.preventDefault();
            setPage(1);
            setApplied(q.trim());
          }}
        >
          <SubTabs
            value={source}
            onChange={(v) => {
              setSource(v as 'SYSTEM' | 'ORDER');
              setPage(1);
            }}
            label="Origen"
            options={[
              { id: 'SYSTEM', label: 'Sistema' },
              { id: 'ORDER', label: 'Pedidos' },
            ]}
          />
          <input
            className="search"
            type="search"
            placeholder="Buscar acción o entidad"
            aria-label="Buscar acción o entidad"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
            }}
          />
          <button type="submit" className="ghost">
            Buscar
          </button>
        </form>
        <AsyncView
          state={data}
          isEmpty={(d) => d.items.length === 0}
          empty={<EmptyState title="Sin eventos" />}
        >
          {(d) => (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Acción</th>
                      <th>Entidad</th>
                      <th>Actor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((e) => (
                      <tr key={e.id}>
                        <td className="small">{formatDateTime(e.createdAt)}</td>
                        <td>
                          <code>{e.action}</code>
                          {e.dryRun && <Badge tone="info">simulación</Badge>}
                          {typeof e.detail['reason'] === 'string' && (
                            <div className="small muted">{e.detail['reason']}</div>
                          )}
                        </td>
                        <td className="small">
                          {[e.entityType, e.entityId].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="small">{e.actor ?? 'Sistema'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                page={d.page}
                pages={Math.max(1, Math.ceil(d.total / d.pageSize))}
                count={d.total}
                total={d.total}
                onPage={setPage}
              />
            </>
          )}
        </AsyncView>
      </Panel>
    </div>
  );
};

/* ================================ Configuración ================================ */

export const SettingsPage = ({ onSwitchWorkspace }: { onSwitchWorkspace: () => void }) => {
  const settings = useAsync(() => api.command.settings(), 'settings');
  const action = useAction();
  const [name, setName] = useState('');
  return (
    <div className="stack">
      <PageHeader
        title="Configuración"
        description="Espacio de trabajo, entorno y estado de los secrets. Los valores de los secrets nunca se muestran."
      />
      <AsyncView state={settings} empty={null}>
        {(s) => (
          <>
            <Panel title="Espacio de trabajo">
              <p className="small">
                <strong>{s.tenant.name}</strong>{' '}
                <span className="muted">
                  · {s.tenant.slug} · {s.tenant.status}
                </span>
              </p>
              <form
                className="form inline-form"
                onSubmit={(e: SubmitEvent) => {
                  e.preventDefault();
                  void action
                    .run(() => api.command.updateSettings(name), 'Nombre actualizado')
                    .then((ok) => {
                      if (ok) {
                        setName('');
                        settings.reload();
                      }
                    });
                }}
              >
                <Field label="Nuevo nombre visible">
                  <input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                    }}
                    required
                    minLength={2}
                  />
                </Field>
                <button type="submit" disabled={action.busy}>
                  Guardar
                </button>
                <button type="button" className="ghost" onClick={onSwitchWorkspace}>
                  Cambiar de espacio
                </button>
              </form>
              <ErrorText>{action.error}</ErrorText>
            </Panel>
            <div className="kpi-grid">
              <Kpi label="Entorno" value={s.environment} />
              <Kpi label="Versión de la API" value={s.apiVersion} />
              <Kpi
                label="Acciones comerciales"
                value={s.commercialActionsEnabled ? 'Habilitadas' : 'Bloqueadas'}
                tone={s.commercialActionsEnabled ? 'bad' : 'good'}
                sub="Interruptor maestro (wrangler.jsonc)"
              />
              <Kpi
                label="Cron Triggers"
                value={`${String(s.cronTriggers.length)} / 5`}
                sub={s.cronTriggers.join(' · ')}
              />
            </div>
            <Panel title="Secrets de integraciones">
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Secret</th>
                      <th>Uso</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.secrets.map((x) => (
                      <tr key={x.name}>
                        <td>
                          <code>{x.name}</code>
                        </td>
                        <td className="small">{x.purpose}</td>
                        <td>
                          {x.configured ? (
                            <Badge tone="good">Configurado</Badge>
                          ) : (
                            <Badge tone="neutral">Sin configurar</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small">
                Se cargan con <code>wrangler secret put NOMBRE</code> o en{' '}
                <code>apps/api/.dev.vars</code> (local). Ver docs/CHANNELS.md.
              </p>
            </Panel>
          </>
        )}
      </AsyncView>
    </div>
  );
};

/* ================================ Finanzas ================================ */

const FinanceSummary = () => {
  const o = useAsync(() => api.command.overview(), 'finance-overview');
  const settled = useAsync(() => api.orders.list('SETTLED'), 'settled');
  const money = (rows: { currency: 'ARS' | 'USD'; cents: number }[]) =>
    rows.length ? rows.map((r) => formatCents(r.cents, r.currency)).join(' · ') : null;
  return (
    <div className="stack">
      <AsyncView state={o} empty={null}>
        {(d) => (
          <div className="kpi-grid">
            <Kpi
              label="Ventas reales (30 días)"
              value={money(d.sales.last30d)}
              tone="good"
              sub="Cobros con evidencia, netos de reembolsos"
            />
            <Kpi
              label="Ventas reales (total)"
              value={money(d.sales.total)}
              sub={`${String(d.sales.paidOrders)} pedido(s) cobrados`}
            />
            <Kpi
              label="Beneficio neto conciliado"
              value={money(d.netProfit.net)}
              tone="good"
              sub={`${String(d.netProfit.settledOrders)} pedido(s) SETTLED`}
            />
            <Kpi
              label="Pedidos bloqueados por fondos"
              value={d.orders.blocked}
              tone={d.orders.blocked > 0 ? 'bad' : undefined}
              sub="Incluye otros bloqueos y reintegros"
            />
          </div>
        )}
      </AsyncView>
      <Panel title="Pedidos conciliados">
        <AsyncView
          state={settled}
          isEmpty={(d) => d.items.length === 0}
          empty={
            <EmptyState title="Sin pedidos conciliados">
              Un pedido se concilia cuando sus movimientos con comprobante coinciden con el neto
              esperado.
            </EmptyState>
          }
        >
          {(d) => (
            <ul className="list compact">
              {d.items.map((x) => (
                <li key={x.id}>
                  #{x.number} · {formatCents(x.totalCents, x.currency)} ·{' '}
                  <Badge tone={stateTone(x.state)}>{STATE_LABEL[x.state]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </AsyncView>
      </Panel>
    </div>
  );
};

export const FinancePage = () => {
  const [view, setView] = useState('resumen');
  return (
    <div className="stack">
      <PageHeader
        title="Finanzas"
        description="Ventas y beneficio reales, fondos disponibles, rentabilidad y Financial Guard. Las reglas financieras no se modifican desde aquí."
      />
      <SubTabs
        value={view}
        onChange={setView}
        label="Finanzas"
        options={[
          { id: 'resumen', label: 'Resumen' },
          { id: 'fondos', label: 'Fondos' },
          { id: 'rentabilidad', label: 'Rentabilidad y Financial Guard' },
        ]}
      />
      {view === 'resumen' && <FinanceSummary />}
      {view === 'fondos' && <FundsView />}
      {view === 'rentabilidad' && <ProfitabilitySection />}
    </div>
  );
};

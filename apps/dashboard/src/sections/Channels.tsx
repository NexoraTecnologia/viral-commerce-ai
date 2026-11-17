import { useState, type SubmitEvent } from 'react';
import type {
  ChannelConnectionDto,
  ChannelKind,
  ChannelListingDto,
  ChannelOperation,
  ConnectionMode,
  ConnectionStatus,
  ConversionStatus,
  ListingStatus,
  PublishCheck,
} from '@vc/shared';
import { CHANNEL_OPERATIONS } from '@vc/shared';
import { api } from '../api-client';
import {
  formatBps,
  formatCents,
  formatDateTime,
  parseMoneyInput,
  parsePercentInput,
  type Tone,
} from '../format';
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

const CHANNEL_LABEL: Record<ChannelKind, string> = {
  MERCADO_LIBRE: 'Mercado Libre',
  INSTAGRAM: 'Instagram',
  WHATSAPP: 'WhatsApp Business',
  OWN_STORE: 'Tienda propia',
  AFFILIATE: 'Afiliados',
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  NOT_CONFIGURED: 'Sin configurar',
  CONNECTED: 'Conectado',
  EXPIRED: 'Vencido',
  ERROR: 'Error',
  DISABLED: 'Deshabilitado',
};
const statusTone = (s: ConnectionStatus): Tone =>
  s === 'CONNECTED' ? 'good' : s === 'EXPIRED' ? 'warn' : s === 'ERROR' ? 'bad' : 'neutral';

const OP_LABEL: Record<ChannelOperation, string> = {
  connect: 'Conectar',
  disconnect: 'Desconectar',
  getConnectionStatus: 'Estado',
  getCatalog: 'Catálogo',
  createListing: 'Publicar',
  updateListing: 'Actualizar',
  pauseListing: 'Pausar',
  getOrders: 'Pedidos',
  getOrderStatus: 'Estado de pedido',
  handleWebhook: 'Webhooks',
};

const LISTING_LABEL: Record<ListingStatus, string> = {
  DRAFT: 'Borrador',
  READY: 'Lista',
  BLOCKED: 'Bloqueada',
  PUBLISHED: 'Publicada',
  PAUSED: 'Pausada',
  ERROR: 'Error',
};
const listingTone = (s: ListingStatus): Tone =>
  s === 'PUBLISHED'
    ? 'good'
    : s === 'READY'
      ? 'warn'
      : s === 'BLOCKED' || s === 'ERROR'
        ? 'bad'
        : 'neutral';

const CHECK_LABEL: Record<PublishCheck, string> = {
  SUPPLIER_VERIFIED: 'Proveedor verificado',
  STOCK_VERIFIABLE: 'Stock verificable',
  MIN_MARGIN: 'Margen mínimo',
  LOGISTICS_CAPACITY: 'Capacidad logística',
  CHANNEL_POLICY: 'Políticas del canal',
  RISK_GUARDIAN: 'Risk Guardian',
  INTEGRATION_AUTHORIZED: 'Integración autorizada',
  COMMERCIAL_ACTIONS_ENABLED: 'Acciones comerciales habilitadas',
};

const ModeBadge = ({ mode }: { mode: ConnectionMode }) =>
  mode === 'MOCK' ? <Badge tone="warn">MOCK · simulado</Badge> : <Badge tone="neutral">LIVE</Badge>;

/* ------------------------------- Conexiones ------------------------------- */

const ConnectionCard = ({ c, onChange }: { c: ChannelConnectionDto; onChange: () => void }) => {
  const action = useAction();
  const [token, setToken] = useState({ accessToken: '', phoneNumberId: '' });
  const [showCaps, setShowCaps] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (await action.run(fn)) onChange();
  };
  const oauth = c.mode === 'LIVE' && (c.channel === 'MERCADO_LIBRE' || c.channel === 'INSTAGRAM');
  return (
    <li className="card">
      <div className="panel-head">
        <strong>
          {c.displayName} · {CHANNEL_LABEL[c.channel]}
        </strong>
        <span className="row-actions">
          <ModeBadge mode={c.mode} />
          <Badge tone={statusTone(c.status)}>{STATUS_LABEL[c.status]}</Badge>
        </span>
      </div>
      <p className="muted small">{c.statusDetail}</p>
      {c.externalAccountName && <p className="small">Cuenta: {c.externalAccountName}</p>}
      {c.tokenExpiresAt && <p className="small">Token vence: {formatDateTime(c.tokenExpiresAt)}</p>}
      {c.lastError && <p className="error small">Último error: {c.lastError}</p>}
      <div className="row-actions wrap">
        {oauth && c.status !== 'DISABLED' && (
          <button
            type="button"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const { authorizationUrl } = await api.channels.startOAuth(c.id);
                window.open(authorizationUrl, '_blank', 'noopener');
              }, 'Se abrió la autorización en otra pestaña')
            }
          >
            Autorizar cuenta
          </button>
        )}
        <button
          type="button"
          disabled={action.busy}
          onClick={() => void run(() => api.channels.check(c.id))}
        >
          Verificar estado
        </button>
        {c.mode === 'LIVE' && c.status !== 'NOT_CONFIGURED' && (
          <button
            type="button"
            disabled={action.busy}
            onClick={() => void run(() => api.channels.disconnect(c.id))}
          >
            Desconectar
          </button>
        )}
        {(c.channel === 'MERCADO_LIBRE' || c.channel === 'OWN_STORE') && (
          <button
            type="button"
            disabled={action.busy}
            onClick={() => void run(() => api.channels.syncOrders(c.id))}
          >
            Sincronizar pedidos
          </button>
        )}
        {c.channel === 'MERCADO_LIBRE' && (
          <button
            type="button"
            disabled={action.busy}
            onClick={() => void run(() => api.channels.syncQuestions(c.id))}
          >
            Sincronizar preguntas
          </button>
        )}
        <button
          type="button"
          disabled={action.busy}
          onClick={() => void run(() => api.channels.setEnabled(c.id, c.status === 'DISABLED'))}
        >
          {c.status === 'DISABLED' ? 'Habilitar' : 'Deshabilitar'}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => {
            setShowCaps((v) => !v);
          }}
        >
          {showCaps ? 'Ocultar capacidades' : 'Ver capacidades'}
        </button>
      </div>
      {c.channel === 'WHATSAPP' && c.mode === 'LIVE' && c.status !== 'CONNECTED' && (
        <form
          className="form inline-form"
          onSubmit={(e: SubmitEvent) => {
            e.preventDefault();
            void run(() => api.channels.connectToken(c.id, token)).then(() => {
              setToken({ accessToken: '', phoneNumberId: '' });
            });
          }}
        >
          <Field
            label="Token de usuario del sistema"
            hint="Se valida contra la API y se guarda cifrado"
          >
            <input
              type="password"
              autoComplete="off"
              value={token.accessToken}
              onChange={(e) => {
                setToken({ ...token, accessToken: e.target.value });
              }}
              required
            />
          </Field>
          <Field label="ID del número de teléfono">
            <input
              inputMode="numeric"
              value={token.phoneNumberId}
              onChange={(e) => {
                setToken({ ...token, phoneNumberId: e.target.value });
              }}
              required
            />
          </Field>
          <button type="submit" disabled={action.busy}>
            Conectar
          </button>
        </form>
      )}
      {showCaps && (
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {CHANNEL_OPERATIONS.map((op) => {
                const cap = c.capabilities[op];
                return (
                  <tr key={op}>
                    <td>{OP_LABEL[op]}</td>
                    <td>
                      <Badge
                        tone={
                          cap.support === 'SUPPORTED'
                            ? 'good'
                            : cap.support === 'LOCAL_ONLY'
                              ? 'neutral'
                              : 'bad'
                        }
                      >
                        {cap.support === 'SUPPORTED'
                          ? 'API oficial'
                          : cap.support === 'LOCAL_ONLY'
                            ? 'Local'
                            : 'No soportado'}
                      </Badge>
                    </td>
                    <td className="small muted">{cap.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ErrorText>{action.error}</ErrorText>
    </li>
  );
};

export const ConnectionsView = () => {
  const list = useAsync(() => api.channels.connections(), 'connections');
  const action = useAction();
  const [form, setForm] = useState<{
    channel: ChannelKind;
    mode: ConnectionMode;
    displayName: string;
  }>({
    channel: 'MERCADO_LIBRE',
    mode: 'MOCK',
    displayName: '',
  });
  const create = async (e: SubmitEvent) => {
    e.preventDefault();
    if (await action.run(() => api.channels.createConnection(form))) {
      setForm({ ...form, displayName: '' });
      list.reload();
    }
  };
  return (
    <Panel title="Conexiones a canales">
      <p className="muted small">
        Una conexión LIVE solo queda <strong>Conectada</strong> después de verificarla contra la API
        oficial. MOCK simula el canal sin red ni credenciales, respetando lo que la API real
        permite. Mientras las acciones comerciales estén deshabilitadas, nada se publica ni se envía
        de verdad.
      </p>
      <form className="form inline-form" onSubmit={(e) => void create(e)}>
        <Field label="Canal">
          <select
            value={form.channel}
            onChange={(e) => {
              setForm({ ...form, channel: e.target.value as ChannelKind });
            }}
          >
            {(Object.keys(CHANNEL_LABEL) as ChannelKind[]).map((k) => (
              <option key={k} value={k}>
                {CHANNEL_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Modo">
          <select
            value={form.mode}
            onChange={(e) => {
              setForm({ ...form, mode: e.target.value as ConnectionMode });
            }}
          >
            <option value="MOCK">MOCK (simulación)</option>
            <option value="LIVE">LIVE (API oficial)</option>
          </select>
        </Field>
        <Field label="Nombre">
          <input
            value={form.displayName}
            onChange={(e) => {
              setForm({ ...form, displayName: e.target.value });
            }}
            required
            minLength={2}
          />
        </Field>
        <button type="submit" disabled={action.busy}>
          Agregar conexión
        </button>
      </form>
      <ErrorText>{action.error}</ErrorText>
      {list.loading && <Loading />}
      <ErrorText>{list.error}</ErrorText>
      {list.data?.items.length ? (
        <ul className="list">
          {list.data.items.map((c) => (
            <ConnectionCard key={c.id} c={c} onChange={list.reload} />
          ))}
        </ul>
      ) : (
        !list.loading && <Empty>Sin conexiones todavía.</Empty>
      )}
    </Panel>
  );
};

/* ------------------------------ Publicaciones ------------------------------ */

const GateChecks = ({ l }: { l: ChannelListingDto }) =>
  l.gate ? (
    <ul className="list compact">
      {l.gate.checks.map((c) => (
        <li key={c.check}>
          <Badge tone={c.passed ? 'good' : 'bad'}>{c.passed ? '✓' : '✗'}</Badge>{' '}
          {CHECK_LABEL[c.check]}
          <span className="muted small"> — {c.detail}</span>
        </li>
      ))}
    </ul>
  ) : null;

export const ListingsView = () => {
  const listings = useAsync(() => api.channels.listings(), 'listings');
  const listControls = useListControls(listings.data?.items, {
    text: (l) => `${l.draft.title} ${CHANNEL_LABEL[l.channel]} ${l.externalId ?? ''}`,
    filter: (l, v) => (v.startsWith('ch:') ? l.channel === v.slice(3) : l.status === v),
    pageSize: 8,
  });
  const connections = useAsync(() => api.channels.connections(), 'conn-for-listings');
  const candidates = useAsync(() => api.discovery.products('CANDIDATE'), 'candidates');
  const action = useAction();
  const [form, setForm] = useState({
    connectionId: '',
    discoveredProductId: '',
    categoryId: '',
    listingTypeId: '',
    condition: '',
  });
  const [preview, setPreview] = useState<string | null>(null);
  const prepare = async (e: SubmitEvent) => {
    e.preventDefault();
    if (
      await action.run(() =>
        api.channels.prepareListing({
          connectionId: form.connectionId,
          discoveredProductId: form.discoveredProductId,
          ...(form.categoryId ? { categoryId: form.categoryId } : {}),
          ...(form.listingTypeId ? { listingTypeId: form.listingTypeId } : {}),
          ...(form.condition === 'new' || form.condition === 'used'
            ? { condition: form.condition }
            : {}),
        }),
      )
    )
      listings.reload();
  };
  const selected = connections.data?.items.find((c) => c.id === form.connectionId);
  return (
    <div className="stack">
      <Panel title="Preparar publicación">
        <p className="muted small">
          Solo productos candidatos (aprobados por Risk Guardian). Se usan el contenido generado y
          las imágenes con autorización registrada. Publicar exige TODAS las condiciones.
        </p>
        <form className="form inline-form" onSubmit={(e) => void prepare(e)}>
          <Field label="Conexión">
            <select
              value={form.connectionId}
              onChange={(e) => {
                setForm({ ...form, connectionId: e.target.value });
              }}
              required
            >
              <option value="">Elegir…</option>
              {connections.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName} ({CHANNEL_LABEL[c.channel]} · {c.mode})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Producto candidato">
            <select
              value={form.discoveredProductId}
              onChange={(e) => {
                setForm({ ...form, discoveredProductId: e.target.value });
              }}
              required
            >
              <option value="">Elegir…</option>
              {candidates.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
          {selected?.channel === 'MERCADO_LIBRE' && (
            <>
              <Field label="Categoría ML" hint="p. ej. MLA1234">
                <input
                  value={form.categoryId}
                  onChange={(e) => {
                    setForm({ ...form, categoryId: e.target.value });
                  }}
                />
              </Field>
              <Field label="Tipo de publicación" hint="Según tu cuenta">
                <input
                  value={form.listingTypeId}
                  onChange={(e) => {
                    setForm({ ...form, listingTypeId: e.target.value });
                  }}
                />
              </Field>
              <Field label="Condición">
                <select
                  value={form.condition}
                  onChange={(e) => {
                    setForm({ ...form, condition: e.target.value });
                  }}
                >
                  <option value="">Elegir…</option>
                  <option value="new">Nuevo</option>
                  <option value="used">Usado</option>
                </select>
              </Field>
            </>
          )}
          <button type="submit" disabled={action.busy}>
            Preparar
          </button>
        </form>
        <ErrorText>{action.error}</ErrorText>
      </Panel>
      <Panel title="Revisar publicaciones">
        <ListToolbar
          controls={listControls}
          placeholder="Buscar publicación"
          filterLabel="Todas"
          filterOptions={[
            ...(Object.keys(LISTING_LABEL) as ListingStatus[]).map((s) => ({
              value: s,
              label: LISTING_LABEL[s],
            })),
            ...(Object.keys(CHANNEL_LABEL) as ChannelKind[]).map((c) => ({
              value: `ch:${c}`,
              label: `Canal: ${CHANNEL_LABEL[c]}`,
            })),
          ]}
        />
        {listings.loading && !listings.data && <Loading />}
        <ErrorText>{listings.error}</ErrorText>
        {listControls.filteredCount > 0 ? (
          <ul className="list">
            {listControls.pageItems.map((l) => (
              <li key={l.id} className="card">
                <div className="panel-head">
                  <strong>{l.draft.title}</strong>
                  <span className="row-actions">
                    <ModeBadge mode={l.mode} />
                    <Badge tone="neutral">{CHANNEL_LABEL[l.channel]}</Badge>
                    <Badge tone={listingTone(l.status)}>{LISTING_LABEL[l.status]}</Badge>
                  </span>
                </div>
                <p className="small">
                  {formatCents(l.draft.priceCents, l.draft.currency)} · {l.draft.imageUrls.length}{' '}
                  imagen(es) autorizada(s)
                  {l.externalId && <> · ID externo {l.externalId}</>}
                </p>
                <GateChecks l={l} />
                {l.lastError && <p className="error small">{l.lastError}</p>}
                <div className="row-actions wrap">
                  {l.status !== 'PUBLISHED' && (
                    <button
                      type="button"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(() => api.channels.publish(l.id)).then(listings.reload)
                      }
                    >
                      {l.mode === 'MOCK' ? 'Simular publicación' : 'Publicar'}
                    </button>
                  )}
                  {l.status === 'PUBLISHED' && (
                    <button
                      type="button"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(() => api.channels.pause(l.id)).then(listings.reload)
                      }
                    >
                      Pausar
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        setPreview(await api.channels.previewHtml(l.id));
                      }, false)
                    }
                  >
                    Vista previa
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          !listings.loading && (
            <Empty>
              {listControls.totalCount === 0
                ? 'Sin publicaciones preparadas.'
                : 'Sin resultados para ese filtro.'}
            </Empty>
          )
        )}
        <ControlsPager controls={listControls} />
      </Panel>
      {preview && (
        <Panel
          title="Vista previa (tienda propia)"
          actions={
            <button
              type="button"
              onClick={() => {
                setPreview(null);
              }}
            >
              Cerrar
            </button>
          }
        >
          <iframe
            title="Vista previa"
            sandbox=""
            srcDoc={preview}
            style={{ width: '100%', height: 480, border: 0 }}
          />
        </Panel>
      )}
    </div>
  );
};

/* --------------------------- Pedidos y mensajes --------------------------- */

export const ChannelOrdersView = () => {
  const orders = useAsync(() => api.channels.orders(), 'orders');
  return (
    <Panel title="Pedidos de canales">
      <p className="muted small">
        Solo pedidos reales informados por el canal (o por webhooks). Se conserva el estado original
        del canal. La tienda propia no tiene pedidos hasta configurar un checkout.
      </p>
      {orders.loading && <Loading />}
      <ErrorText>{orders.error}</ErrorText>
      {orders.data?.items.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Canal</th>
                <th>Pedido</th>
                <th>Estado</th>
                <th>Total</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {orders.data.items.map((o) => (
                <tr key={o.id}>
                  <td>{CHANNEL_LABEL[o.channel]}</td>
                  <td>{o.externalOrderId}</td>
                  <td>
                    {o.status} <span className="muted small">({o.rawStatus})</span>
                  </td>
                  <td>
                    {o.totalCents === null
                      ? '—'
                      : o.currency === 'ARS' || o.currency === 'USD'
                        ? formatCents(o.totalCents, o.currency)
                        : `${o.currency ?? ''} ${o.totalCents / 100}`}
                  </td>
                  <td>{o.placedAt ? formatDateTime(o.placedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !orders.loading && <Empty>Sin pedidos sincronizados.</Empty>
      )}
    </Panel>
  );
};

export const MessagesView = () => {
  const messages = useAsync(() => api.channels.messages(), 'messages');
  const connections = useAsync(() => api.channels.connections(), 'conn-for-messages');
  const action = useAction();
  const [form, setForm] = useState({ connectionId: '', contactRef: '', text: '' });
  const usable =
    connections.data?.items.filter(
      (c) => c.channel === 'WHATSAPP' || c.channel === 'MERCADO_LIBRE',
    ) ?? [];
  const prepare = async (e: SubmitEvent) => {
    e.preventDefault();
    if (await action.run(() => api.channels.prepareMessage(form))) {
      setForm({ ...form, text: '' });
      messages.reload();
    }
  };
  return (
    <div className="stack">
      <Panel title="Preparar mensaje o respuesta">
        <p className="muted small">
          WhatsApp: texto libre solo dentro de las 24 h desde el último mensaje del cliente; fuera
          de esa ventana, solo plantillas aprobadas. Mercado Libre: respuestas a preguntas (máx.
          2000 caracteres). Enviar es una acción comercial.
        </p>
        <form className="form inline-form" onSubmit={(e) => void prepare(e)}>
          <Field label="Conexión">
            <select
              value={form.connectionId}
              onChange={(e) => {
                setForm({ ...form, connectionId: e.target.value });
              }}
              required
            >
              <option value="">Elegir…</option>
              {usable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName} ({CHANNEL_LABEL[c.channel]} · {c.mode})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Contacto / ID de pregunta">
            <input
              value={form.contactRef}
              onChange={(e) => {
                setForm({ ...form, contactRef: e.target.value });
              }}
              required
            />
          </Field>
          <Field label="Texto">
            <textarea
              value={form.text}
              onChange={(e) => {
                setForm({ ...form, text: e.target.value });
              }}
              required
              maxLength={4096}
            />
          </Field>
          <button type="submit" disabled={action.busy}>
            Guardar borrador
          </button>
        </form>
        <ErrorText>{action.error}</ErrorText>
      </Panel>
      <Panel title="Bandeja">
        {messages.loading && <Loading />}
        <ErrorText>{messages.error}</ErrorText>
        {messages.data?.items.length ? (
          <ul className="list">
            {messages.data.items.map((m) => (
              <li key={m.id}>
                <Badge tone={m.direction === 'INBOUND' ? 'neutral' : 'warn'}>
                  {m.direction === 'INBOUND' ? 'Entrante' : 'Saliente'}
                </Badge>{' '}
                <Badge
                  tone={
                    m.status === 'BLOCKED' || m.status === 'FAILED'
                      ? 'bad'
                      : m.status === 'DRAFT'
                        ? 'neutral'
                        : 'good'
                  }
                >
                  {m.status}
                </Badge>{' '}
                <strong>{CHANNEL_LABEL[m.channel]}</strong> · {m.contactRef} — {m.body}
                {m.detail && <span className="muted small"> ({m.detail})</span>}
                {m.direction === 'OUTBOUND' && (m.status === 'DRAFT' || m.status === 'BLOCKED') && (
                  <button
                    type="button"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(() => api.channels.sendMessage(m.id)).then(messages.reload)
                    }
                  >
                    Enviar
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          !messages.loading && <Empty>Sin mensajes.</Empty>
        )}
      </Panel>
    </div>
  );
};

/* -------------------------------- Afiliados -------------------------------- */

const CONVERSION_LABEL: Record<ConversionStatus, string> = {
  PENDING: 'Pendiente',
  APPROVED: 'Aprobada',
  REJECTED: 'Rechazada',
  PAID: 'Pagada',
};

export const AffiliatesView = () => {
  const networks = useAsync(() => api.affiliates.networks(), 'aff-networks');
  const products = useAsync(() => api.affiliates.products(), 'aff-products');
  const links = useAsync(() => api.affiliates.links(), 'aff-links');
  const conversions = useAsync(() => api.affiliates.conversions(), 'aff-conv');
  const summary = useAsync(() => api.affiliates.summary(), 'aff-summary');
  const action = useAction();
  const [net, setNet] = useState({ name: '', website: '' });
  const [prod, setProd] = useState({
    networkId: '',
    title: '',
    productUrl: '',
    rate: '',
    rateSource: '',
  });
  const [link, setLink] = useState({ productId: '', destinationUrl: '', campaign: '' });
  const [conv, setConv] = useState({
    linkId: '',
    externalRef: '',
    sale: '',
    commission: '',
    sourceRef: '',
    occurredAt: '',
  });
  const reloadAll = () => {
    networks.reload();
    products.reload();
    links.reload();
    conversions.reload();
    summary.reload();
  };
  const submit = (fn: () => Promise<unknown>, reset: () => void) => async (e: SubmitEvent) => {
    e.preventDefault();
    if (await action.run(fn)) {
      reset();
      reloadAll();
    }
  };
  const s = summary.data;
  return (
    <div className="stack">
      <Panel title="Resumen">
        {s ? (
          <p>
            {s.clicks} clics · {s.conversions} conversiones · tasa{' '}
            {s.conversionRateBps === null ? '— (sin clics)' : formatBps(s.conversionRateBps)}
            {s.commissions.map((c) => (
              <span key={`${c.currency}-${c.status}`}>
                {' '}
                · {CONVERSION_LABEL[c.status]}: {formatCents(c.totalCents, c.currency)}
              </span>
            ))}
          </p>
        ) : (
          <Loading />
        )}
        <p className="muted small">
          Sin conector de red: los enlaces los emite la red y las conversiones se registran con su
          reporte. No se estiman comisiones sin una tasa respaldada.
        </p>
      </Panel>
      <Panel title="Redes y productos">
        <form
          className="form inline-form"
          onSubmit={(e) =>
            void submit(
              () =>
                api.affiliates.createNetwork({
                  name: net.name,
                  ...(net.website ? { website: net.website } : {}),
                }),
              () => {
                setNet({ name: '', website: '' });
              },
            )(e)
          }
        >
          <Field label="Red">
            <input
              value={net.name}
              onChange={(e) => {
                setNet({ ...net, name: e.target.value });
              }}
              required
            />
          </Field>
          <Field label="Sitio">
            <input
              type="url"
              value={net.website}
              onChange={(e) => {
                setNet({ ...net, website: e.target.value });
              }}
            />
          </Field>
          <button type="submit" disabled={action.busy}>
            Agregar red
          </button>
        </form>
        <form
          className="form inline-form"
          onSubmit={(e) => {
            const rate = prod.rate ? parsePercentInput(prod.rate) : null;
            void submit(
              () =>
                api.affiliates.createProduct({
                  networkId: prod.networkId,
                  title: prod.title,
                  productUrl: prod.productUrl,
                  ...(rate !== null
                    ? { commissionRateBps: rate, commissionSourceRef: prod.rateSource }
                    : {}),
                }),
              () => {
                setProd({ ...prod, title: '', productUrl: '', rate: '', rateSource: '' });
              },
            )(e);
          }}
        >
          <Field label="Red">
            <select
              value={prod.networkId}
              onChange={(e) => {
                setProd({ ...prod, networkId: e.target.value });
              }}
              required
            >
              <option value="">Elegir…</option>
              {networks.data?.items.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Producto">
            <input
              value={prod.title}
              onChange={(e) => {
                setProd({ ...prod, title: e.target.value });
              }}
              required
            />
          </Field>
          <Field label="URL (https)">
            <input
              type="url"
              value={prod.productUrl}
              onChange={(e) => {
                setProd({ ...prod, productUrl: e.target.value });
              }}
              required
            />
          </Field>
          <Field label="Comisión %" hint="Opcional">
            <input
              value={prod.rate}
              onChange={(e) => {
                setProd({ ...prod, rate: e.target.value });
              }}
            />
          </Field>
          <Field label="Fuente de la tasa" hint="Obligatoria si hay tasa">
            <input
              value={prod.rateSource}
              onChange={(e) => {
                setProd({ ...prod, rateSource: e.target.value });
              }}
            />
          </Field>
          <button type="submit" disabled={action.busy}>
            Agregar producto
          </button>
        </form>
        <ErrorText>{action.error}</ErrorText>
        {products.data?.items.length ? (
          <ul className="list compact">
            {products.data.items.map((p) => (
              <li key={p.id}>
                {p.title} —{' '}
                {p.commissionRateBps === null
                  ? 'sin tasa registrada'
                  : `${formatBps(p.commissionRateBps)} (${p.commissionSourceRef ?? ''})`}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Sin productos afiliados.</Empty>
        )}
      </Panel>
      <Panel title="Enlaces de seguimiento">
        <form
          className="form inline-form"
          onSubmit={(e) =>
            void submit(
              () =>
                api.affiliates.createLink({
                  productId: link.productId,
                  destinationUrl: link.destinationUrl,
                  ...(link.campaign ? { campaign: link.campaign } : {}),
                }),
              () => {
                setLink({ ...link, destinationUrl: '', campaign: '' });
              },
            )(e)
          }
        >
          <Field label="Producto">
            <select
              value={link.productId}
              onChange={(e) => {
                setLink({ ...link, productId: e.target.value });
              }}
              required
            >
              <option value="">Elegir…</option>
              {products.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Enlace emitido por la red (https)">
            <input
              type="url"
              value={link.destinationUrl}
              onChange={(e) => {
                setLink({ ...link, destinationUrl: e.target.value });
              }}
              required
            />
          </Field>
          <Field label="Campaña">
            <input
              value={link.campaign}
              onChange={(e) => {
                setLink({ ...link, campaign: e.target.value });
              }}
            />
          </Field>
          <button type="submit" disabled={action.busy}>
            Crear enlace
          </button>
        </form>
        {links.data?.items.length ? (
          <ul className="list compact">
            {links.data.items.map((l) => (
              <li key={l.id}>
                <code>{api.affiliates.trackingUrl(l.code)}</code> → {l.destinationUrl} · {l.clicks}{' '}
                clics · {l.conversions} conv.{' '}
                <Badge tone={l.active ? 'good' : 'neutral'}>
                  {l.active ? 'Activo' : 'Inactivo'}
                </Badge>{' '}
                <button
                  type="button"
                  disabled={action.busy}
                  onClick={() =>
                    void action
                      .run(() => api.affiliates.setLinkActive(l.id, !l.active))
                      .then(reloadAll)
                  }
                >
                  {l.active ? 'Desactivar' : 'Activar'}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Sin enlaces.</Empty>
        )}
      </Panel>
      <Panel title="Conversiones">
        <form
          className="form inline-form"
          onSubmit={(e) => {
            const sale = parseMoneyInput(conv.sale);
            const commission = conv.commission ? parseMoneyInput(conv.commission) : null;
            void submit(
              () =>
                api.affiliates.recordConversion({
                  linkId: conv.linkId,
                  externalRef: conv.externalRef,
                  saleCents: sale ?? -1,
                  currency: 'ARS',
                  ...(commission !== null ? { commissionCents: commission } : {}),
                  sourceRef: conv.sourceRef,
                  occurredAt: new Date(`${conv.occurredAt}T12:00:00-03:00`).toISOString(),
                }),
              () => {
                setConv({ ...conv, externalRef: '', sale: '', commission: '' });
              },
            )(e);
          }}
        >
          <Field label="Enlace">
            <select
              value={conv.linkId}
              onChange={(e) => {
                setConv({ ...conv, linkId: e.target.value });
              }}
              required
            >
              <option value="">Elegir…</option>
              {links.data?.items.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code}
                  {l.campaign ? ` (${l.campaign})` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ref. de la red">
            <input
              value={conv.externalRef}
              onChange={(e) => {
                setConv({ ...conv, externalRef: e.target.value });
              }}
              required
            />
          </Field>
          <Field label="Venta (ARS)">
            <input
              value={conv.sale}
              onChange={(e) => {
                setConv({ ...conv, sale: e.target.value });
              }}
              required
            />
          </Field>
          <Field label="Comisión informada" hint="Vacío = calcular con la tasa">
            <input
              value={conv.commission}
              onChange={(e) => {
                setConv({ ...conv, commission: e.target.value });
              }}
            />
          </Field>
          <Field label="Respaldo" hint="Reporte o comprobante">
            <input
              value={conv.sourceRef}
              onChange={(e) => {
                setConv({ ...conv, sourceRef: e.target.value });
              }}
              required
            />
          </Field>
          <Field label="Fecha">
            <input
              type="date"
              value={conv.occurredAt}
              onChange={(e) => {
                setConv({ ...conv, occurredAt: e.target.value });
              }}
              required
            />
          </Field>
          <button type="submit" disabled={action.busy}>
            Registrar
          </button>
        </form>
        {conversions.data?.items.length ? (
          <ul className="list compact">
            {conversions.data.items.map((c) => (
              <li key={c.id}>
                {c.externalRef}: venta {formatCents(c.saleCents, c.currency)} · comisión{' '}
                {formatCents(c.commissionCents, c.currency)} ·{' '}
                <select
                  value={c.status}
                  onChange={(e) =>
                    void action
                      .run(() =>
                        api.affiliates.setConversionStatus(
                          c.id,
                          e.target.value as ConversionStatus,
                        ),
                      )
                      .then(reloadAll)
                  }
                >
                  {(Object.keys(CONVERSION_LABEL) as ConversionStatus[]).map((k) => (
                    <option key={k} value={k}>
                      {CONVERSION_LABEL[k]}
                    </option>
                  ))}
                </select>
                <span className="muted small"> {c.sourceRef}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Sin conversiones registradas.</Empty>
        )}
      </Panel>
    </div>
  );
};

/* -------------------------------- Registro -------------------------------- */

export const LogView = () => {
  const logs = useAsync(() => api.channels.logs(), 'logs');
  const events = useAsync(() => api.channels.webhookEvents(), 'webhooks');
  return (
    <div className="stack">
      <Panel
        title="Registro de operaciones"
        actions={
          <button type="button" onClick={logs.reload}>
            Actualizar
          </button>
        }
      >
        <ErrorText>{logs.error}</ErrorText>
        {logs.data?.items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Canal</th>
                  <th>Operación</th>
                  <th>Resultado</th>
                  <th>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {logs.data.items.map((l) => (
                  <tr key={l.id}>
                    <td>{formatDateTime(l.createdAt)}</td>
                    <td>{CHANNEL_LABEL[l.channel]}</td>
                    <td>{l.operation}</td>
                    <td>
                      <Badge
                        tone={
                          l.outcome === 'OK' ? 'good' : l.outcome === 'BLOCKED' ? 'warn' : 'bad'
                        }
                      >
                        {l.outcome}
                      </Badge>
                    </td>
                    <td className="small">
                      {l.errorCode ?? ''} {l.message ?? ''}{' '}
                      {l.httpStatus ? `(HTTP ${l.httpStatus})` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Sin operaciones registradas.</Empty>
        )}
      </Panel>
      <Panel
        title="Webhooks recibidos"
        actions={
          <button type="button" onClick={events.reload}>
            Actualizar
          </button>
        }
      >
        <ErrorText>{events.error}</ErrorText>
        {events.data?.items.length ? (
          <ul className="list compact">
            {events.data.items.map((w) => (
              <li key={w.id}>
                {formatDateTime(w.receivedAt)} · {CHANNEL_LABEL[w.channel]} · {w.topic}{' '}
                {w.resource ?? ''} —{' '}
                <Badge
                  tone={
                    w.status === 'PROCESSED' ? 'good' : w.status === 'FAILED' ? 'bad' : 'neutral'
                  }
                >
                  {w.status}
                </Badge>
                {w.detail && <span className="muted small"> {w.detail}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Sin webhooks.</Empty>
        )}
      </Panel>
    </div>
  );
};

/* -------------------------------- Sección -------------------------------- */

const VIEWS = [
  { id: 'conexiones', label: 'Conexiones' },
  { id: 'publicaciones', label: 'Publicaciones' },
  { id: 'pedidos', label: 'Pedidos' },
  { id: 'mensajes', label: 'Mensajes' },
  { id: 'afiliados', label: 'Afiliados' },
  { id: 'registro', label: 'Registro' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

export const ChannelsSection = () => {
  const [view, setView] = useState<ViewId>('conexiones');
  return (
    <div className="stack">
      <nav className="subtabs" aria-label="Canales">
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
      {view === 'conexiones' && <ConnectionsView />}
      {view === 'publicaciones' && <ListingsView />}
      {view === 'pedidos' && <ChannelOrdersView />}
      {view === 'mensajes' && <MessagesView />}
      {view === 'afiliados' && <AffiliatesView />}
      {view === 'registro' && <LogView />}
    </div>
  );
};

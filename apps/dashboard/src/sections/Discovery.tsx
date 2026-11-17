import { useState, type SubmitEvent } from 'react';
import type {
  AttributeVerification,
  CompetitorDto,
  DemandMetric,
  DiscoveredProductDto,
  DiscoveryStatus,
  GeneratedContentDto,
  ImageAuthorization,
  RiskCheck,
  ScoreComponentName,
  SourceKind,
  SourceStatus,
} from '@vc/shared';
import { api } from '../api-client';
import { formatCents, parseMoneyInput, type Tone } from '../format';
import { Badge, Empty, ErrorText, Field, Loading, Panel, useAction, useAsync } from '../ui';

/* ---------- Etiquetas ---------- */

const RISK_LABEL: Record<RiskCheck, string> = {
  SUPPLIER_LINKED: 'Sin oferta de proveedor vinculada',
  PRODUCT_LINKED: 'Sin producto propio vinculado',
  SUPPLIER_VERIFIED: 'Proveedor no verificado o evidencia vencida',
  STOCK_CONFIRMED: 'Stock no confirmado o desactualizado',
  PRICE_CURRENT: 'Precio del proveedor desactualizado',
  CURRENCY_MATCH: 'Monedas distintas',
  MIN_MARGIN: 'Margen por debajo del mínimo',
};

const COMPONENT_LABEL: Record<ScoreComponentName, string> = {
  PROFITABILITY: 'Rentabilidad',
  SUPPLIER_RELIABILITY: 'Confiabilidad del proveedor',
  AVAILABILITY: 'Disponibilidad',
  COMPETITION: 'Competencia',
  DEMAND: 'Demanda observada',
  LOGISTICS: 'Facilidad logística',
};

const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  GOOGLE_TRENDS: 'Google Trends',
  PUBLIC_SOURCE: 'Fuente pública',
  COMMERCIAL_API: 'API comercial autorizada',
  SUPPLIER_CATALOG: 'Catálogo de proveedores',
  MANUAL: 'Carga manual',
};

const sourceTone = (s: SourceStatus): Tone =>
  s === 'CONFIGURED' ? 'good' : s === 'ERROR' ? 'bad' : 'neutral';

const METRIC_LABEL: Record<DemandMetric, string> = {
  SEARCH_INTEREST: 'Interés de búsqueda',
  SALES_RANK: 'Ranking de ventas',
  REVIEWS_COUNT: 'Cantidad de reseñas',
  UNITS_SOLD: 'Unidades vendidas',
  OTHER: 'Otra',
};

/** Fecha del dato (día) interpretada como mediodía en Argentina para no correr de día. */
const dateToIso = (yyyyMmDd: string) => new Date(`${yyyyMmDd}T12:00:00-03:00`).toISOString();
const shortDate = (iso: string) =>
  new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    dateStyle: 'short',
  }).format(new Date(iso));

const ScoreBadge = ({ p }: { p: DiscoveredProductDto }) =>
  p.latestScore === null ? (
    <Badge tone="neutral">Sin analizar</Badge>
  ) : (
    <Badge tone={p.latestScore >= 65 ? 'good' : p.latestScore >= 40 ? 'warn' : 'bad'}>
      {p.latestScore}/100
    </Badge>
  );

const Signals = ({ p }: { p: DiscoveredProductDto }) => (
  <span className="row-actions">
    {p.opportunity && <Badge tone="good">Oportunidad</Badge>}
    {p.saturated && <Badge tone="bad">Saturado</Badge>}
    {p.riskPassed === true && <Badge tone="good">Risk OK</Badge>}
    {p.riskPassed === false && <Badge tone="warn">Risk bloquea</Badge>}
  </span>
);

/* ---------- Detalle ---------- */

const ObservationForms = ({ id, onSaved }: { id: string; onSaved: () => void }) => {
  const sources = useAsync(() => api.discovery.sources(), 'sources');
  const competitors = useAsync(() => api.discovery.competitors(), 'competitors');
  const action = useAction();
  const [kind, setKind] = useState<'demand' | 'price' | 'attribute' | 'image'>('demand');
  const [f, setF] = useState({
    sourceId: '',
    sourceRef: '',
    date: '',
    metric: 'SEARCH_INTEREST' as DemandMetric,
    value: '',
    unit: '',
    price: '',
    competitorId: '',
    name: '',
    attrValue: '',
    verification: 'SUPPLIER_DECLARED' as AttributeVerification,
    url: '',
    authorization: 'NONE' as ImageAuthorization,
    authorizationRef: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF((v) => ({ ...v, [k]: e.target.value }));
  };
  const usable = sources.data?.items.filter((s) => s.enabled) ?? [];

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const provenance = {
      sourceId: f.sourceId,
      sourceRef: f.sourceRef,
      observedAt: f.date ? dateToIso(f.date) : '',
    };
    const ok = await action.run(async () => {
      if (kind === 'demand') {
        await api.discovery.recordDemand(id, {
          ...provenance,
          metric: f.metric,
          value: Number(f.value),
          unit: f.unit,
        });
      } else if (kind === 'price') {
        const cents = parseMoneyInput(f.price);
        if (cents === null) throw new Error('Precio inválido');
        await api.discovery.recordPrice(id, {
          ...provenance,
          priceCents: cents,
          currency: 'ARS',
          ...(f.competitorId ? { competitorId: f.competitorId } : {}),
        });
      } else if (kind === 'attribute') {
        await api.discovery.recordAttribute(id, {
          ...provenance,
          name: f.name,
          value: f.attrValue,
          verification: f.verification,
        });
      } else {
        await api.discovery.recordImage(id, {
          url: f.url,
          authorization: f.authorization,
          ...(f.authorizationRef ? { authorizationRef: f.authorizationRef } : {}),
        });
      }
    });
    if (ok) {
      setF((v) => ({
        ...v,
        value: '',
        price: '',
        name: '',
        attrValue: '',
        url: '',
        authorizationRef: '',
      }));
      onSaved();
    }
  };

  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <div className="inline-form">
        <Field label="Registrar">
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as typeof kind);
            }}
          >
            <option value="demand">Demanda observada</option>
            <option value="price">Precio observado</option>
            <option value="attribute">Característica</option>
            <option value="image">Imagen</option>
          </select>
        </Field>
        {kind !== 'image' && (
          <>
            <Field label="Fuente">
              <select required value={f.sourceId} onChange={set('sourceId')}>
                <option value="">Elegir…</option>
                {usable.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Referencia" hint="URL o identificador verificable">
              <input required value={f.sourceRef} onChange={set('sourceRef')} />
            </Field>
            <Field label="Fecha del dato">
              <input required type="date" value={f.date} onChange={set('date')} />
            </Field>
          </>
        )}
      </div>
      <div className="inline-form">
        {kind === 'demand' && (
          <>
            <Field label="Métrica">
              <select value={f.metric} onChange={set('metric')}>
                {(Object.keys(METRIC_LABEL) as DemandMetric[]).map((m) => (
                  <option key={m} value={m}>
                    {METRIC_LABEL[m]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Valor">
              <input
                required
                type="number"
                min={0}
                step="any"
                value={f.value}
                onChange={set('value')}
              />
            </Field>
            <Field label="Unidad" hint="Tal como la informa la fuente">
              <input required value={f.unit} onChange={set('unit')} />
            </Field>
          </>
        )}
        {kind === 'price' && (
          <>
            <Field label="Precio (ARS)">
              <input required inputMode="decimal" value={f.price} onChange={set('price')} />
            </Field>
            <Field label="Competidor">
              <select value={f.competitorId} onChange={set('competitorId')}>
                <option value="">Sin competidor</option>
                {competitors.data?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        {kind === 'attribute' && (
          <>
            <Field label="Nombre">
              <input required value={f.name} onChange={set('name')} />
            </Field>
            <Field label="Valor">
              <input required value={f.attrValue} onChange={set('attrValue')} />
            </Field>
            <Field label="Verificación" hint="Solo verificadas o declaradas van al contenido">
              <select value={f.verification} onChange={set('verification')}>
                <option value="VERIFIED">Verificada</option>
                <option value="SUPPLIER_DECLARED">Declarada por el proveedor</option>
                <option value="UNVERIFIED">Sin verificar</option>
              </select>
            </Field>
          </>
        )}
        {kind === 'image' && (
          <>
            <Field label="URL">
              <input required type="url" value={f.url} onChange={set('url')} />
            </Field>
            <Field label="Autorización">
              <select value={f.authorization} onChange={set('authorization')}>
                <option value="NONE">Sin autorización (no se usa)</option>
                <option value="OWN_PHOTO">Foto propia</option>
                <option value="SUPPLIER_WRITTEN">Autorización escrita del proveedor</option>
                <option value="LICENSED">Licencia</option>
              </select>
            </Field>
            <Field label="Evidencia de la autorización">
              <input value={f.authorizationRef} onChange={set('authorizationRef')} />
            </Field>
          </>
        )}
        <button type="submit" disabled={action.busy}>
          Guardar
        </button>
      </div>
      <ErrorText>{action.error}</ErrorText>
    </form>
  );
};

const LinkForm = ({ p, onSaved }: { p: DiscoveredProductDto; onSaved: () => void }) => {
  const products = useAsync(() => api.products.list(), 'products');
  const offers = useAsync(() => api.offers.list(), 'offers');
  const action = useAction();
  const [productId, setProductId] = useState(p.productId ?? '');
  const [offerId, setOfferId] = useState(p.supplierProductId ?? '');
  const save = async (e: SubmitEvent) => {
    e.preventDefault();
    if (
      await action.run(() =>
        api.discovery.updateProduct(p.id, {
          productId: productId || null,
          supplierProductId: offerId || null,
        }),
      )
    ) {
      onSaved();
    }
  };
  return (
    <form className="form inline-form" onSubmit={(e) => void save(e)}>
      <Field label="Producto propio">
        <select
          value={productId}
          onChange={(e) => {
            setProductId(e.target.value);
          }}
        >
          <option value="">Sin vincular</option>
          {products.data?.items.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Oferta del proveedor">
        <select
          value={offerId}
          onChange={(e) => {
            setOfferId(e.target.value);
          }}
        >
          <option value="">Sin vincular</option>
          {offers.data?.items.map((o) => (
            <option key={o.id} value={o.id}>
              {o.supplierName} · {o.title}
            </option>
          ))}
        </select>
      </Field>
      <button type="submit" className="ghost" disabled={action.busy}>
        Guardar vínculos
      </button>
      <ErrorText>{action.error}</ErrorText>
    </form>
  );
};

const Detail = ({ id, onChanged }: { id: string; onChanged: () => void }) => {
  const detail = useAsync(() => api.discovery.product(id), id);
  const action = useAction();
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error) return <ErrorText>{detail.error}</ErrorText>;
  const d = detail.data;
  if (!d) return null;
  const { product: p, analysis } = d;
  const refresh = () => {
    detail.reload();
    onChanged();
  };
  const run = async (fn: () => Promise<unknown>, msg?: string) => {
    setNotice(null);
    if (await action.run(fn)) {
      if (msg) setNotice(msg);
      refresh();
    }
  };

  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <h3>{p.title}</h3>
          <p className="muted small">
            {p.categoryName
              ? `${p.categoryName}${p.categorySource === 'RULE' ? ' (por palabras clave)' : ''} · `
              : ''}
            Fuente: {p.sourceName} · {p.sourceRef} · {shortDate(p.observedAt)}
          </p>
        </div>
        <ScoreBadge p={p} />
      </div>

      <div className="row-actions wrap">
        <button
          type="button"
          disabled={action.busy}
          onClick={() => void run(() => api.discovery.analyze(p.id), 'Análisis actualizado.')}
        >
          Analizar
        </button>
        {p.status === 'RESEARCHING' && (
          <button
            type="button"
            className="ghost"
            disabled={action.busy}
            onClick={() => void run(() => api.discovery.promote(p.id), 'Promovido a candidato.')}
          >
            Promover a candidato
          </button>
        )}
        {!p.categoryId && d.suggestedCategoryId && (
          <button
            type="button"
            className="ghost"
            disabled={action.busy}
            onClick={() => void run(() => api.discovery.classify(p.id))}
          >
            Clasificar automáticamente
          </button>
        )}
        {p.status === 'CANDIDATE' && (
          <button
            type="button"
            className="ghost"
            disabled={action.busy}
            onClick={() =>
              void run(
                () => api.discovery.generateContent(p.id),
                'Contenido generado (ver pestaña Contenido).',
              )
            }
          >
            Generar contenido
          </button>
        )}
        {p.status === 'DISCARDED' ? (
          <button
            type="button"
            className="ghost"
            disabled={action.busy}
            onClick={() => void run(() => api.discovery.reopen(p.id))}
          >
            Reabrir
          </button>
        ) : (
          <span className="inline-form">
            <input
              placeholder="Motivo del descarte"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
            <button
              type="button"
              className="ghost danger"
              disabled={action.busy || reason.trim().length < 3}
              onClick={() => void run(() => api.discovery.discard(p.id, reason))}
            >
              Descartar
            </button>
          </span>
        )}
      </div>
      <ErrorText>{action.error}</ErrorText>
      {notice && <p className="small">{notice}</p>}
      {p.discardReason && <p className="notice">Descartado: {p.discardReason}</p>}

      {analysis && (
        <>
          <h4>
            Puntuación ({Math.round(analysis.score.confidence * 100)} % de los datos disponibles)
          </h4>
          <table className="table breakdown">
            <tbody>
              {analysis.score.components.map((c) => (
                <tr key={c.name}>
                  <td>
                    {COMPONENT_LABEL[c.name]} <span className="muted small">({c.weight} %)</span>
                  </td>
                  <td className="num">{c.value ?? '—'}</td>
                  <td className="small muted">{c.basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Mercado</h4>
          <p className="small">
            Tendencia: <strong>{analysis.signals.trend}</strong> ({analysis.signals.demandPoints}{' '}
            observaciones) · Competidores: {analysis.signals.competitorCount} · Precio mediano:{' '}
            {analysis.signals.medianPriceCents !== null
              ? formatCents(analysis.signals.medianPriceCents)
              : '—'}
          </p>
          {analysis.signals.saturationReasons.length > 0 && (
            <p className="notice">Saturación: {analysis.signals.saturationReasons.join(' · ')}</p>
          )}
          <p className="small muted">
            Oportunidad: {analysis.signals.opportunityReasons.join(' · ')}
          </p>
          <h4>Risk Guardian</h4>
          {analysis.risk.passed ? (
            <Badge tone="good">Todos los controles obligatorios pasan</Badge>
          ) : (
            <ul className="issues">
              {analysis.risk.blockers.map((b) => (
                <li key={b}>{RISK_LABEL[b]}</li>
              ))}
            </ul>
          )}
          {analysis.risk.warnings.length > 0 && (
            <p className="small muted">{analysis.risk.warnings.join(' · ')}</p>
          )}
          <p className="small muted">La puntuación no puede saltear estos controles.</p>
        </>
      )}

      <h4>Vínculos comerciales</h4>
      <LinkForm p={p} onSaved={refresh} />

      <h4>Registrar datos (con fuente y fecha)</h4>
      <ObservationForms id={p.id} onSaved={refresh} />

      <h4>Datos registrados</h4>
      {d.observations.length === 0 ? (
        <Empty>Sin datos. No se infiere demanda ni precios que no se observaron.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Dato</th>
                <th>Valor</th>
                <th>Fuente</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {d.observations.map((o) => (
                <tr key={o.id}>
                  <td className="small">{o.kind}</td>
                  <td>{o.kind === 'DEMAND' ? METRIC_LABEL[o.label as DemandMetric] : o.label}</td>
                  <td>{o.value}</td>
                  <td className="small">
                    {o.sourceName}
                    <div className="muted">{o.sourceRef}</div>
                  </td>
                  <td className="small">{shortDate(o.observedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.images.length > 0 && (
        <ul className="list compact">
          {d.images.map((i) => (
            <li key={i.id}>
              <span className="small">{i.url}</span>
              <Badge tone={i.authorization === 'NONE' ? 'bad' : 'good'}>
                {i.authorization === 'NONE' ? 'No se usará' : i.authorization}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/* ---------- Listas ---------- */

const NewDiscovered = ({ onCreated }: { onCreated: () => void }) => {
  const sources = useAsync(() => api.discovery.sources(), 'sources');
  const action = useAction();
  const [f, setF] = useState({ title: '', sourceId: '', sourceRef: '', date: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF((v) => ({ ...v, [k]: e.target.value }));
  };
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (
      await action.run(() =>
        api.discovery.createProduct({
          title: f.title,
          sourceId: f.sourceId,
          sourceRef: f.sourceRef,
          observedAt: dateToIso(f.date),
        }),
      )
    ) {
      setF({ title: '', sourceId: f.sourceId, sourceRef: '', date: f.date });
      onCreated();
    }
  };
  return (
    <form className="form inline-form" onSubmit={(e) => void submit(e)}>
      <Field label="Producto detectado">
        <input required minLength={2} value={f.title} onChange={set('title')} />
      </Field>
      <Field label="Fuente">
        <select required value={f.sourceId} onChange={set('sourceId')}>
          <option value="">Elegir…</option>
          {sources.data?.items
            .filter((s) => s.enabled)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Referencia">
        <input required value={f.sourceRef} onChange={set('sourceRef')} />
      </Field>
      <Field label="Fecha">
        <input required type="date" value={f.date} onChange={set('date')} />
      </Field>
      <button type="submit" disabled={action.busy}>
        Registrar
      </button>
      <ErrorText>{action.error}</ErrorText>
    </form>
  );
};

const ProductTable = ({
  items,
  selected,
  onSelect,
}: {
  items: DiscoveredProductDto[];
  selected: string | null;
  onSelect: (id: string) => void;
}) => (
  <div className="table-wrap">
    <table className="table">
      <thead>
        <tr>
          <th>Producto</th>
          <th>Puntaje</th>
          <th>Señales</th>
        </tr>
      </thead>
      <tbody>
        {items.map((p) => (
          <tr
            key={p.id}
            tabIndex={0}
            className={p.id === selected ? 'selected' : ''}
            onClick={() => {
              onSelect(p.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelect(p.id);
            }}
          >
            <td>
              {p.title}
              <div className="muted small">
                {p.categoryName ?? 'Sin categoría'} · {p.sourceName}
              </div>
            </td>
            <td>
              <ScoreBadge p={p} />
            </td>
            <td>
              <Signals p={p} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const ListView = ({
  title,
  status,
  withCreate,
}: {
  title: string;
  status: DiscoveryStatus | 'RADAR';
  withCreate?: boolean;
}) => {
  const list = useAsync(
    () => (status === 'RADAR' ? api.discovery.radar() : api.discovery.products(status)),
    status,
  );
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="split">
      <Panel title={title}>
        {withCreate && <NewDiscovered onCreated={list.reload} />}
        {status === 'RADAR' && (
          <p className="muted small">
            Ordenado por oportunidad y puntaje. Una oportunidad no aprueba nada: decide Risk
            Guardian.
          </p>
        )}
        {list.error && <ErrorText>{list.error}</ErrorText>}
        {list.loading && !list.data ? (
          <Loading />
        ) : list.data?.items.length ? (
          <ProductTable items={list.data.items} selected={selected} onSelect={setSelected} />
        ) : (
          <Empty>No hay productos en esta lista.</Empty>
        )}
      </Panel>
      <Panel title="Detalle">
        {selected ? (
          <Detail id={selected} onChanged={list.reload} />
        ) : (
          <Empty>Elegí un producto.</Empty>
        )}
      </Panel>
    </div>
  );
};

const ContentCard = ({ c }: { c: GeneratedContentDto }) => {
  const [open, setOpen] = useState(false);
  const x = c.content;
  return (
    <li className="content-card">
      <div className="detail-head">
        <div>
          <strong>{x.commercialName}</strong>
          <div className="muted small">
            v{c.version} · plantilla {c.templateVersion} · {shortDate(c.createdAt)}
          </div>
        </div>
        <span className="row-actions">
          <Badge tone={c.compliance.ok ? 'good' : 'bad'}>
            {c.compliance.ok ? 'Sin afirmaciones indebidas' : 'Revisar'}
          </Badge>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setOpen((v) => !v);
            }}
          >
            {open ? 'Cerrar' : 'Ver'}
          </button>
        </span>
      </div>
      {open && (
        <div className="content-fields">
          {c.compliance.violations.length > 0 && (
            <ul className="issues">
              {c.compliance.violations.map((v, i) => (
                <li key={i}>
                  {v.field}: “{v.term}” ({v.rule})
                </li>
              ))}
            </ul>
          )}
          <p className="small muted">
            Excluidos: {c.compliance.excludedAttributes} atributo(s) sin verificar,{' '}
            {c.compliance.excludedImages} imagen(es) sin autorización.
          </p>
          <h4>Título SEO</h4>
          <p>{x.seoTitle}</p>
          <h4>Descripción</h4>
          <p>{x.description}</p>
          <h4>Características</h4>
          {x.features.length ? (
            <ul>
              {x.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : (
            <Empty>Sin características verificadas.</Empty>
          )}
          <h4>Beneficios</h4>
          {x.benefits.length ? (
            <ul>
              {x.benefits.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : (
            <Empty>Sin datos del proveedor para beneficios.</Empty>
          )}
          <h4>Preguntas frecuentes</h4>
          {x.faq.map((q) => (
            <p key={q.question}>
              <strong>{q.question}</strong> {q.answer}
            </p>
          ))}
          <h4>Instagram</h4>
          <pre className="code">{x.instagram}</pre>
          <h4>WhatsApp</h4>
          <pre className="code">{x.whatsapp}</pre>
          <h4>Tienda</h4>
          <pre className="code">{x.storeDescription}</pre>
          <h4>Marketplaces</h4>
          <pre className="code">{x.marketplaceDescription}</pre>
          <h4>Imágenes autorizadas</h4>
          {x.images.length ? (
            <ul>
              {x.images.map((u) => (
                <li key={u} className="small">
                  {u}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Ninguna.</Empty>
          )}
        </div>
      )}
    </li>
  );
};

const ContentView = () => {
  const contents = useAsync(() => api.discovery.contents(), 'contents');
  return (
    <Panel title="Contenido generado">
      <p className="muted small">
        Plantillas propias: solo usan datos registrados. No agregan características, promesas ni
        imágenes sin autorización.
      </p>
      {contents.error && <ErrorText>{contents.error}</ErrorText>}
      {contents.data?.items.length ? (
        <ul className="list">
          {contents.data.items.map((c) => (
            <ContentCard key={c.id} c={c} />
          ))}
        </ul>
      ) : (
        <Empty>Sin contenido. Se genera desde un producto candidato.</Empty>
      )}
    </Panel>
  );
};

const SourcesView = () => {
  const sources = useAsync(() => api.discovery.sources(), 'sources');
  const categories = useAsync(() => api.discovery.categories(), 'categories');
  const competitors = useAsync(() => api.discovery.competitors(), 'competitors');
  const action = useAction();
  const [src, setSrc] = useState({
    name: '',
    kind: 'MANUAL' as SourceKind,
    reference: '',
    usageAuthorization: '',
  });
  const [cat, setCat] = useState({ name: '', keywords: '' });
  const [comp, setComp] = useState<{ name: string; channel: CompetitorDto['channel'] }>({
    name: '',
    channel: 'MARKETPLACE',
  });
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const addSource = async (e: SubmitEvent) => {
    e.preventDefault();
    if (
      await action.run(() =>
        api.discovery.createSource({
          name: src.name,
          kind: src.kind,
          ...(src.reference ? { reference: src.reference } : {}),
          ...(src.usageAuthorization ? { usageAuthorization: src.usageAuthorization } : {}),
        }),
      )
    ) {
      setSrc({ name: '', kind: src.kind, reference: '', usageAuthorization: '' });
      sources.reload();
    }
  };

  return (
    <div className="stack">
      <Panel title="Fuentes de investigación">
        <form className="form inline-form" onSubmit={(e) => void addSource(e)}>
          <Field label="Nombre">
            <input
              required
              minLength={2}
              value={src.name}
              onChange={(e) => {
                setSrc((v) => ({ ...v, name: e.target.value }));
              }}
            />
          </Field>
          <Field label="Tipo">
            <select
              value={src.kind}
              onChange={(e) => {
                setSrc((v) => ({ ...v, kind: e.target.value as SourceKind }));
              }}
            >
              {(Object.keys(SOURCE_KIND_LABEL) as SourceKind[]).map((k) => (
                <option key={k} value={k}>
                  {SOURCE_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Referencia">
            <input
              value={src.reference}
              onChange={(e) => {
                setSrc((v) => ({ ...v, reference: e.target.value }));
              }}
            />
          </Field>
          <Field label="Autorización de uso" hint="Términos, contrato o permiso">
            <input
              value={src.usageAuthorization}
              onChange={(e) => {
                setSrc((v) => ({ ...v, usageAuthorization: e.target.value }));
              }}
            />
          </Field>
          <button type="submit" disabled={action.busy}>
            Agregar fuente
          </button>
        </form>
        <ErrorText>{action.error}</ErrorText>
        {syncMsg && <p className="small">{syncMsg}</p>}
        {sources.data?.items.length ? (
          <ul className="list">
            {sources.data.items.map((s) => (
              <li key={s.id}>
                <span>
                  <strong>{s.name}</strong> · {SOURCE_KIND_LABEL[s.kind]}
                  <div className="muted small">{s.statusDetail}</div>
                </span>
                <span className="row-actions">
                  <Badge tone={sourceTone(s.status)}>{s.status}</Badge>
                  {s.kind !== 'MANUAL' && (
                    <button
                      type="button"
                      className="ghost"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          const r = await api.discovery.syncSource(s.id);
                          setSyncMsg(`${s.name}: ${r.status} — ${r.message}`);
                          sources.reload();
                        })
                      }
                    >
                      Sincronizar
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Sin fuentes. Agregá al menos una carga manual.</Empty>
        )}
      </Panel>
      <div className="split">
        <Panel title="Categorías">
          <form
            className="form inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void action
                .run(() =>
                  api.discovery.createCategory({
                    name: cat.name,
                    keywords: cat.keywords
                      .split(',')
                      .map((k) => k.trim())
                      .filter((k) => k.length >= 2),
                  }),
                )
                .then((ok) => {
                  if (ok) {
                    setCat({ name: '', keywords: '' });
                    categories.reload();
                  }
                });
            }}
          >
            <Field label="Nombre">
              <input
                required
                minLength={2}
                value={cat.name}
                onChange={(e) => {
                  setCat((v) => ({ ...v, name: e.target.value }));
                }}
              />
            </Field>
            <Field label="Palabras clave" hint="Separadas por coma">
              <input
                value={cat.keywords}
                onChange={(e) => {
                  setCat((v) => ({ ...v, keywords: e.target.value }));
                }}
              />
            </Field>
            <button type="submit" disabled={action.busy}>
              Agregar
            </button>
          </form>
          <ul className="list compact">
            {categories.data?.items.map((c) => (
              <li key={c.id}>
                <span>
                  <strong>{c.name}</strong>{' '}
                  <span className="muted small">{c.keywords.join(', ')}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Competidores">
          <form
            className="form inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void action
                .run(() =>
                  api.discovery.createCompetitor({
                    name: comp.name,
                    channel: comp.channel,
                  }),
                )
                .then((ok) => {
                  if (ok) {
                    setComp((v) => ({ ...v, name: '' }));
                    competitors.reload();
                  }
                });
            }}
          >
            <Field label="Nombre">
              <input
                required
                minLength={2}
                value={comp.name}
                onChange={(e) => {
                  setComp((v) => ({ ...v, name: e.target.value }));
                }}
              />
            </Field>
            <Field label="Canal">
              <select
                value={comp.channel}
                onChange={(e) => {
                  setComp((v) => ({ ...v, channel: e.target.value as CompetitorDto['channel'] }));
                }}
              >
                <option value="MARKETPLACE">Marketplace</option>
                <option value="ECOMMERCE">Tienda online</option>
                <option value="SOCIAL">Redes sociales</option>
                <option value="RETAIL">Local físico</option>
                <option value="OTHER">Otro</option>
              </select>
            </Field>
            <button type="submit" disabled={action.busy}>
              Agregar
            </button>
          </form>
          <ul className="list compact">
            {competitors.data?.items.map((c) => (
              <li key={c.id}>
                <span>
                  <strong>{c.name}</strong> <span className="muted small">{c.channel}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
};

/* ---------- Sección ---------- */

const VIEWS = [
  { id: 'radar', label: 'Radar de oportunidades' },
  { id: 'investigados', label: 'Investigados' },
  { id: 'candidatos', label: 'Candidatos' },
  { id: 'descartados', label: 'Descartados' },
  { id: 'contenido', label: 'Contenido' },
  { id: 'fuentes', label: 'Fuentes y datos' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

export const DiscoverySection = () => {
  const [view, setView] = useState<ViewId>('radar');
  return (
    <div className="stack">
      <nav className="subtabs" aria-label="Descubrimiento">
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
      {view === 'radar' && <ListView title="Radar de oportunidades" status="RADAR" />}
      {view === 'investigados' && (
        <ListView title="Productos investigados" status="RESEARCHING" withCreate />
      )}
      {view === 'candidatos' && <ListView title="Productos candidatos" status="CANDIDATE" />}
      {view === 'descartados' && <ListView title="Productos descartados" status="DISCARDED" />}
      {view === 'contenido' && <ContentView />}
      {view === 'fuentes' && <SourcesView />}
    </div>
  );
};

import { useState, type SubmitEvent } from 'react';
import { SUPPLIER_TRANSITIONS, type EvidenceCategory, type SupplierStatus } from '@vc/shared';
import { api } from '../api-client';
import { EVIDENCE_LABEL, formatDateTime, SUPPLIER_STATUS_LABEL, supplierTone } from '../format';
import { Badge, Empty, ErrorText, Field, Loading, Panel, useAction, useAsync } from '../ui';

const SupplierForm = ({ onCreated }: { onCreated: () => void }) => {
  const action = useAction();
  const [form, setForm] = useState({
    legalName: '',
    taxId: '',
    countryCode: 'AR',
    province: '',
    city: '',
    contactName: '',
    contactEmail: '',
    directDispatch: true,
    trackingAvailable: false,
    acceptsReturns: false,
    returnWindowDays: '',
    requiresPrepayment: true,
    paymentDueDays: '',
    dispatchLeadTimeDaysMax: '',
    deliveryTimeDaysMax: '',
  });
  const set = (k: keyof typeof form, v: string | boolean) => {
    setForm((f) => ({ ...f, [k]: v }));
  };
  const optInt = (v: string) => (v.trim() === '' ? undefined : Number(v));
  const optText = (v: string) => (v.trim() === '' ? undefined : v.trim());

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const ok = await action.run(() =>
      api.suppliers.create({
        legalName: form.legalName,
        taxId: optText(form.taxId),
        countryCode: form.countryCode.toUpperCase(),
        province: optText(form.province),
        city: optText(form.city),
        contacts: form.contactName
          ? [{ name: form.contactName, email: optText(form.contactEmail) }]
          : [],
        paymentMethods: [],
        directDispatch: form.directDispatch,
        trackingAvailable: form.trackingAvailable,
        acceptsReturns: form.acceptsReturns,
        returnWindowDays: optInt(form.returnWindowDays),
        requiresPrepayment: form.requiresPrepayment,
        paymentDueDays: optInt(form.paymentDueDays),
        dispatchLeadTimeDaysMax: optInt(form.dispatchLeadTimeDaysMax),
        deliveryTimeDaysMax: optInt(form.deliveryTimeDaysMax),
      }),
    );
    if (ok) onCreated();
  };

  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <div className="grid">
        <Field label="Razón social">
          <input
            required
            value={form.legalName}
            onChange={(e) => {
              set('legalName', e.target.value);
            }}
          />
        </Field>
        <Field label="CUIT" hint="Opcional, 11 dígitos">
          <input
            value={form.taxId}
            onChange={(e) => {
              set('taxId', e.target.value);
            }}
          />
        </Field>
        <Field label="País (ISO)">
          <input
            required
            maxLength={2}
            value={form.countryCode}
            onChange={(e) => {
              set('countryCode', e.target.value);
            }}
          />
        </Field>
        <Field label="Provincia">
          <input
            value={form.province}
            onChange={(e) => {
              set('province', e.target.value);
            }}
          />
        </Field>
        <Field label="Ciudad">
          <input
            value={form.city}
            onChange={(e) => {
              set('city', e.target.value);
            }}
          />
        </Field>
        <Field label="Contacto">
          <input
            value={form.contactName}
            onChange={(e) => {
              set('contactName', e.target.value);
            }}
          />
        </Field>
        <Field label="Email del contacto">
          <input
            type="email"
            value={form.contactEmail}
            onChange={(e) => {
              set('contactEmail', e.target.value);
            }}
          />
        </Field>
        <Field label="Preparación (días máx.)">
          <input
            type="number"
            min={0}
            value={form.dispatchLeadTimeDaysMax}
            onChange={(e) => {
              set('dispatchLeadTimeDaysMax', e.target.value);
            }}
          />
        </Field>
        <Field label="Entrega (días máx.)">
          <input
            type="number"
            min={0}
            value={form.deliveryTimeDaysMax}
            onChange={(e) => {
              set('deliveryTimeDaysMax', e.target.value);
            }}
          />
        </Field>
        <Field label="Ventana de devolución (días)">
          <input
            type="number"
            min={0}
            value={form.returnWindowDays}
            onChange={(e) => {
              set('returnWindowDays', e.target.value);
            }}
          />
        </Field>
        <Field label="Plazo de pago al proveedor (días)" hint="0 = al hacer el pedido">
          <input
            type="number"
            min={0}
            value={form.paymentDueDays}
            onChange={(e) => {
              set('paymentDueDays', e.target.value);
            }}
          />
        </Field>
      </div>
      <div className="checks">
        {(
          [
            ['directDispatch', 'Despacha directo al comprador'],
            ['trackingAvailable', 'Ofrece seguimiento'],
            ['acceptsReturns', 'Acepta devoluciones'],
            ['requiresPrepayment', 'Exige pago anticipado'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="check">
            <input
              type="checkbox"
              checked={form[k]}
              onChange={(e) => {
                set(k, e.target.checked);
              }}
            />
            {label}
          </label>
        ))}
      </div>
      <ErrorText>{action.error}</ErrorText>
      <button type="submit" disabled={action.busy}>
        Registrar proveedor
      </button>
    </form>
  );
};

const SupplierDetail = ({ id, onChanged }: { id: string; onChanged: () => void }) => {
  const detail = useAsync(() => api.suppliers.get(id), id);
  const action = useAction();
  const [evidence, setEvidence] = useState({
    category: 'IDENTITY' as EvidenceCategory,
    description: '',
    reference: '',
    expiresAt: '',
  });
  const [transition, setTransition] = useState({ to: '' as SupplierStatus | '', reason: '' });

  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error) return <ErrorText>{detail.error}</ErrorText>;
  if (!detail.data) return null;
  const { supplier, score, missingEvidence, history } = detail.data;
  const refresh = () => {
    detail.reload();
    onChanged();
  };

  const addEvidence = async (e: SubmitEvent) => {
    e.preventDefault();
    const ok = await action.run(() =>
      api.suppliers.recordEvidence(id, {
        category: evidence.category,
        description: evidence.description,
        reference: evidence.reference,
        ...(evidence.expiresAt ? { expiresAt: new Date(evidence.expiresAt).toISOString() } : {}),
      }),
    );
    if (ok) {
      setEvidence((v) => ({ ...v, description: '', reference: '', expiresAt: '' }));
      refresh();
    }
  };

  const review = async (evidenceId: string, decision: 'ACCEPTED' | 'REJECTED') => {
    if (await action.run(() => api.suppliers.reviewEvidence(id, evidenceId, { decision })))
      refresh();
  };

  const changeStatus = async (e: SubmitEvent) => {
    e.preventDefault();
    if (!transition.to) return;
    const to = transition.to;
    if (await action.run(() => api.suppliers.changeStatus(id, { to, reason: transition.reason }))) {
      setTransition({ to: '', reason: '' });
      refresh();
    }
  };

  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <h3>{supplier.legalName}</h3>
          <p className="muted">
            {[supplier.city, supplier.province, supplier.countryCode].filter(Boolean).join(', ')}
            {supplier.taxId ? ` · CUIT ${supplier.taxId}` : ''}
          </p>
        </div>
        <Badge tone={supplierTone(supplier.status)}>{SUPPLIER_STATUS_LABEL[supplier.status]}</Badge>
      </div>

      <dl className="stats">
        <div>
          <dt>Puntaje</dt>
          <dd className="big">{score.total}</dd>
        </div>
        <div>
          <dt>Evidencia</dt>
          <dd>{score.evidence}/40</dd>
        </div>
        <div>
          <dt>Operación</dt>
          <dd>{score.operations}/35</dd>
        </div>
        <div>
          <dt>Comercial</dt>
          <dd>{score.commercial}/25</dd>
        </div>
        {score.penalties < 0 && (
          <div>
            <dt>Penalidad</dt>
            <dd>{score.penalties}</dd>
          </div>
        )}
      </dl>

      {missingEvidence.length > 0 && (
        <p className="notice">
          Para verificar falta evidencia aceptada de:{' '}
          {missingEvidence.map((c) => EVIDENCE_LABEL[c]).join(', ')}.
        </p>
      )}

      <h4>Evidencia de verificación</h4>
      {detail.data.evidence.length === 0 ? (
        <Empty>Sin evidencia registrada.</Empty>
      ) : (
        <ul className="list">
          {detail.data.evidence.map((ev) => (
            <li key={ev.id}>
              <div>
                <strong>{EVIDENCE_LABEL[ev.category]}</strong> — {ev.description}
                <div className="muted small">
                  Ref: {ev.reference}
                  {ev.expiresAt ? ` · vence ${formatDateTime(ev.expiresAt)}` : ''}
                </div>
              </div>
              {ev.reviewStatus === 'PENDING' ? (
                <span className="row-actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={action.busy}
                    onClick={() => void review(ev.id, 'ACCEPTED')}
                  >
                    Aceptar
                  </button>
                  <button
                    type="button"
                    className="ghost danger"
                    disabled={action.busy}
                    onClick={() => void review(ev.id, 'REJECTED')}
                  >
                    Rechazar
                  </button>
                </span>
              ) : (
                <Badge tone={ev.reviewStatus === 'ACCEPTED' ? 'good' : 'bad'}>
                  {ev.reviewStatus === 'ACCEPTED' ? 'Aceptada' : 'Rechazada'}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      <form className="form inline-form" onSubmit={(e) => void addEvidence(e)}>
        <Field label="Categoría">
          <select
            value={evidence.category}
            onChange={(e) => {
              setEvidence((v) => ({ ...v, category: e.target.value as EvidenceCategory }));
            }}
          >
            {(Object.keys(EVIDENCE_LABEL) as EvidenceCategory[]).map((c) => (
              <option key={c} value={c}>
                {EVIDENCE_LABEL[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Descripción">
          <input
            required
            minLength={5}
            value={evidence.description}
            onChange={(e) => {
              setEvidence((v) => ({ ...v, description: e.target.value }));
            }}
          />
        </Field>
        <Field label="Referencia" hint="URL, n.º de constancia o documento">
          <input
            required
            minLength={3}
            value={evidence.reference}
            onChange={(e) => {
              setEvidence((v) => ({ ...v, reference: e.target.value }));
            }}
          />
        </Field>
        <Field label="Vence">
          <input
            type="date"
            value={evidence.expiresAt}
            onChange={(e) => {
              setEvidence((v) => ({ ...v, expiresAt: e.target.value }));
            }}
          />
        </Field>
        <button type="submit" disabled={action.busy}>
          Registrar evidencia
        </button>
      </form>

      <h4>Estado</h4>
      <form className="form inline-form" onSubmit={(e) => void changeStatus(e)}>
        <Field label="Nuevo estado">
          <select
            required
            value={transition.to}
            onChange={(e) => {
              setTransition((t) => ({ ...t, to: e.target.value as SupplierStatus }));
            }}
          >
            <option value="">Elegir…</option>
            {SUPPLIER_TRANSITIONS[supplier.status].map((s) => (
              <option key={s} value={s}>
                {SUPPLIER_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Motivo">
          <input
            required
            minLength={3}
            value={transition.reason}
            onChange={(e) => {
              setTransition((t) => ({ ...t, reason: e.target.value }));
            }}
          />
        </Field>
        <button type="submit" disabled={action.busy || !transition.to}>
          Cambiar estado
        </button>
      </form>
      <ErrorText>{action.error}</ErrorText>

      <h4>Historial de verificación</h4>
      {history.length === 0 ? (
        <Empty>Sin cambios de estado.</Empty>
      ) : (
        <ul className="list compact">
          {history.map((h) => (
            <li key={h.id}>
              <span>
                {SUPPLIER_STATUS_LABEL[h.fromStatus]} →{' '}
                <strong>{SUPPLIER_STATUS_LABEL[h.toStatus]}</strong> — {h.reason}
              </span>
              <span className="muted small">{formatDateTime(h.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const SuppliersSection = () => {
  const suppliers = useAsync(() => api.suppliers.list(), 'all');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="split">
      <Panel
        title="Proveedores"
        actions={
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setCreating((c) => !c);
            }}
          >
            {creating ? 'Cancelar' : 'Nuevo proveedor'}
          </button>
        }
      >
        {creating && (
          <SupplierForm
            onCreated={() => {
              setCreating(false);
              suppliers.reload();
            }}
          />
        )}
        {suppliers.error && <ErrorText>{suppliers.error}</ErrorText>}
        {suppliers.loading && !suppliers.data ? (
          <Loading />
        ) : suppliers.data?.items.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Proveedor</th>
                <th>Estado</th>
                <th className="num">Puntaje</th>
                <th>Despacho directo</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.data.items.map((s) => (
                <tr
                  key={s.id}
                  className={s.id === selected ? 'selected' : ''}
                  onClick={() => {
                    setSelected(s.id);
                  }}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setSelected(s.id);
                  }}
                >
                  <td>
                    {s.legalName}
                    <div className="muted small">
                      {s.countryCode}
                      {s.province ? ` · ${s.province}` : ''}
                    </div>
                  </td>
                  <td>
                    <Badge tone={supplierTone(s.status)}>{SUPPLIER_STATUS_LABEL[s.status]}</Badge>
                  </td>
                  <td className="num">{s.score}</td>
                  <td>{s.directDispatch ? 'Sí' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          !creating && <Empty>Todavía no hay proveedores. Registrá el primero.</Empty>
        )}
      </Panel>
      <Panel title="Detalle">
        {selected ? (
          <SupplierDetail id={selected} onChanged={suppliers.reload} />
        ) : (
          <Empty>Elegí un proveedor para ver su evidencia, estado e historial.</Empty>
        )}
      </Panel>
    </div>
  );
};

import { Fragment, useEffect, useState, type SubmitEvent } from 'react';
import type {
  CreateScheduleRequest,
  JobDto,
  JobStatus,
  ScheduleDto,
  ScheduleFrequency,
} from '@vc/shared';
import { api } from '../api-client';
import type { Tone } from '../format';
import { Badge, Empty, ErrorText, Field, Loading, Panel, useAction, useAsync } from '../ui';

const AR_TZ = 'America/Argentina/Buenos_Aires';

/**
 * Formatea un instante (devuelto por el servidor) en hora de Argentina. Se usa la
 * zona explícita, no la del navegador, y la hora "actual" sale del servidor.
 */
const formatAr = (iso: string | null): string =>
  iso
    ? new Intl.DateTimeFormat('es-AR', {
        timeZone: AR_TZ,
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(iso))
    : '—';

const relative = (iso: string | null, serverNowIso: string | undefined): string => {
  if (!iso || !serverNowIso) return '';
  const diffMin = Math.round((new Date(iso).getTime() - new Date(serverNowIso).getTime()) / 60_000);
  if (diffMin === 0) return 'ahora';
  return diffMin > 0 ? `en ${diffMin} min` : `hace ${-diffMin} min`;
};

const STATUS_LABEL: Record<JobStatus, string> = {
  PENDING: 'Pendiente',
  SCHEDULED: 'Programado',
  RUNNING: 'Ejecutando',
  COMPLETED: 'Completado',
  FAILED: 'Fallido',
  RETRYING: 'Reintentando',
  CANCELLED: 'Cancelado',
  DEAD_LETTER: 'Dead letter',
};

const statusTone = (s: JobStatus): Tone =>
  s === 'COMPLETED'
    ? 'good'
    : s === 'FAILED' || s === 'DEAD_LETTER'
      ? 'bad'
      : s === 'RETRYING' || s === 'RUNNING'
        ? 'warn'
        : 'neutral';

const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const describeFrequency = (f: ScheduleFrequency): string =>
  f.kind === 'INTERVAL'
    ? `Cada ${f.everyMinutes} min`
    : f.kind === 'DAILY'
      ? `Todos los días ${f.localTime}`
      : `${f.daysOfWeek.map((d) => DAYS[d]).join(', ')} ${f.localTime}`;

/* ---------- Editor de frecuencia ---------- */

interface FrequencyDraft {
  kind: ScheduleFrequency['kind'];
  everyMinutes: string;
  localTime: string;
  days: number[];
}

const draftFrom = (f?: ScheduleFrequency): FrequencyDraft => ({
  kind: f?.kind ?? 'DAILY',
  everyMinutes: f?.kind === 'INTERVAL' ? String(f.everyMinutes) : '60',
  localTime: f && f.kind !== 'INTERVAL' ? f.localTime : '09:00',
  days: f?.kind === 'WEEKLY' ? f.daysOfWeek : [1, 2, 3, 4, 5],
});

const toFrequency = (d: FrequencyDraft): ScheduleFrequency | null => {
  if (d.kind === 'INTERVAL') {
    const n = Number(d.everyMinutes);
    return Number.isInteger(n) && n >= 1 ? { kind: 'INTERVAL', everyMinutes: n } : null;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.localTime)) return null;
  if (d.kind === 'DAILY') return { kind: 'DAILY', localTime: d.localTime };
  return d.days.length ? { kind: 'WEEKLY', localTime: d.localTime, daysOfWeek: d.days } : null;
};

const FrequencyFields = ({
  draft,
  onChange,
}: {
  draft: FrequencyDraft;
  onChange: (d: FrequencyDraft) => void;
}) => (
  <>
    <Field label="Frecuencia">
      <select
        value={draft.kind}
        onChange={(e) => {
          onChange({ ...draft, kind: e.target.value as FrequencyDraft['kind'] });
        }}
      >
        <option value="INTERVAL">Cada N minutos</option>
        <option value="DAILY">Diaria</option>
        <option value="WEEKLY">Semanal</option>
      </select>
    </Field>
    {draft.kind === 'INTERVAL' ? (
      <Field label="Minutos">
        <input
          type="number"
          min={1}
          max={10080}
          required
          value={draft.everyMinutes}
          onChange={(e) => {
            onChange({ ...draft, everyMinutes: e.target.value });
          }}
        />
      </Field>
    ) : (
      <Field label="Hora (Argentina)" hint="24 h, UTC−3">
        <input
          type="time"
          required
          value={draft.localTime}
          onChange={(e) => {
            onChange({ ...draft, localTime: e.target.value });
          }}
        />
      </Field>
    )}
    {draft.kind === 'WEEKLY' && (
      <div className="checks">
        {DAYS.map((label, d) => (
          <label key={label} className="check">
            <input
              type="checkbox"
              checked={draft.days.includes(d)}
              onChange={(e) => {
                onChange({
                  ...draft,
                  days: e.target.checked
                    ? [...draft.days, d].sort()
                    : draft.days.filter((x) => x !== d),
                });
              }}
            />
            {label}
          </label>
        ))}
      </div>
    )}
  </>
);

/* ---------- Programaciones ---------- */

const ScheduleRow = ({
  s,
  serverNow,
  onChanged,
}: {
  s: ScheduleDto;
  serverNow: string | undefined;
  onChanged: () => void;
}) => {
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftFrom(s.frequency));

  const save = async (e: SubmitEvent) => {
    e.preventDefault();
    const frequency = toFrequency(draft);
    if (!frequency) {
      action.setError('Frecuencia inválida.');
      return;
    }
    if (await action.run(() => api.automation.updateSchedule(s.id, { frequency }))) {
      setEditing(false);
      onChanged();
    }
  };

  const toggle = async () => {
    if (await action.run(() => api.automation.updateSchedule(s.id, { enabled: !s.enabled }))) {
      onChanged();
    }
  };

  return (
    <>
      <tr>
        <td>
          {s.name}
          <div className="muted small">{s.jobType}</div>
        </td>
        <td>
          {describeFrequency(s.frequency)}
          <div className="muted small">{s.timeZone === AR_TZ ? 'Hora Argentina' : s.timeZone}</div>
        </td>
        <td>
          {s.enabled ? formatAr(s.nextRunAt) : '—'}
          <div className="muted small">{s.enabled ? relative(s.nextRunAt, serverNow) : ''}</div>
        </td>
        <td>{formatAr(s.lastRunAt)}</td>
        <td>
          <Badge tone={s.enabled ? 'good' : 'neutral'}>{s.enabled ? 'Activa' : 'Pausada'}</Badge>
        </td>
        <td className="row-actions">
          <button
            type="button"
            className="ghost"
            disabled={action.busy}
            onClick={() => void toggle()}
          >
            {s.enabled ? 'Pausar' : 'Activar'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setEditing((v) => !v);
            }}
          >
            {editing ? 'Cerrar' : 'Editar'}
          </button>
        </td>
      </tr>
      {(editing || action.error) && (
        <tr className="row-editor">
          <td colSpan={6}>
            {editing && (
              <form className="form inline-form" onSubmit={(e) => void save(e)}>
                <FrequencyFields draft={draft} onChange={setDraft} />
                <button type="submit" disabled={action.busy}>
                  Guardar frecuencia
                </button>
              </form>
            )}
            <ErrorText>{action.error}</ErrorText>
          </td>
        </tr>
      )}
    </>
  );
};

const NewSchedule = ({ types, onCreated }: { types: string[]; onCreated: () => void }) => {
  const action = useAction();
  const [name, setName] = useState('');
  const [jobType, setJobType] = useState('');
  const [draft, setDraft] = useState(() => draftFrom());

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const frequency = toFrequency(draft);
    if (!frequency) {
      action.setError('Frecuencia inválida.');
      return;
    }
    const body: CreateScheduleRequest = {
      name,
      jobType,
      payload: {},
      frequency,
      timeZone: AR_TZ,
      enabled: true,
    };
    if (await action.run(() => api.automation.createSchedule(body))) {
      setName('');
      onCreated();
    }
  };

  return (
    <form className="form inline-form" onSubmit={(e) => void submit(e)}>
      <Field label="Nombre">
        <input
          required
          minLength={2}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </Field>
      <Field label="Trabajo">
        <select
          required
          value={jobType}
          onChange={(e) => {
            setJobType(e.target.value);
          }}
        >
          <option value="">Elegir…</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>
      <FrequencyFields draft={draft} onChange={setDraft} />
      <button type="submit" disabled={action.busy}>
        Crear programación
      </button>
      <ErrorText>{action.error}</ErrorText>
    </form>
  );
};

/* ---------- Trabajos ---------- */

const JobAttempts = ({ id }: { id: string }) => {
  const detail = useAsync(() => api.automation.job(id), id);
  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error) return <ErrorText>{detail.error}</ErrorText>;
  const d = detail.data;
  if (!d) return null;
  return (
    <div>
      {d.job.result !== null && <pre className="code">{JSON.stringify(d.job.result, null, 2)}</pre>}
      {d.attempts.length === 0 ? (
        <Empty>Sin intentos todavía.</Empty>
      ) : (
        <ul className="list compact">
          {d.attempts.map((a) => (
            <li key={a.id}>
              <span>
                Intento {a.attempt}: <strong>{a.status}</strong>
                {a.errorKind ? ` · ${a.errorKind}` : ''}
                {a.error ? ` — ${a.error}` : ''}
              </span>
              <span className="muted small">
                {formatAr(a.startedAt)}
                {a.durationMs !== null ? ` · ${a.durationMs} ms` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const JobRow = ({ job, onChanged }: { job: JobDto; onChanged: () => void }) => {
  const action = useAction();
  const [open, setOpen] = useState(false);
  const cancellable = ['PENDING', 'SCHEDULED', 'RETRYING'].includes(job.status);
  const retryable = job.status === 'FAILED' || job.status === 'DEAD_LETTER';

  return (
    <Fragment>
      <tr
        tabIndex={0}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <td>
          {job.type}
          <div className="muted small">{job.idempotencyKey}</div>
        </td>
        <td>
          <Badge tone={statusTone(job.status)}>{STATUS_LABEL[job.status]}</Badge>
        </td>
        <td className="num">{job.priority}</td>
        <td className="num">
          {job.attempts}/{job.maxAttempts}
        </td>
        <td>{formatAr(job.runAt)}</td>
        <td className="small">{job.lastError ?? '—'}</td>
        <td
          className="row-actions"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          {cancellable && (
            <button
              type="button"
              className="ghost danger"
              disabled={action.busy}
              onClick={() =>
                void action.run(() => api.automation.cancelJob(job.id)).then(onChanged)
              }
            >
              Cancelar
            </button>
          )}
          {retryable && (
            <button
              type="button"
              className="ghost"
              disabled={action.busy}
              onClick={() => void action.run(() => api.automation.retryJob(job.id)).then(onChanged)}
            >
              Reintentar
            </button>
          )}
        </td>
      </tr>
      {(open || action.error) && (
        <tr className="row-editor">
          <td colSpan={7}>
            <ErrorText>{action.error}</ErrorText>
            {open && <JobAttempts id={job.id} />}
          </td>
        </tr>
      )}
    </Fragment>
  );
};

const NewJob = ({ types, onCreated }: { types: string[]; onCreated: () => void }) => {
  const action = useAction();
  const [type, setType] = useState('');
  const [key, setKey] = useState('');
  const [payload, setPayload] = useState('{}');
  const [note, setNote] = useState<string | null>(null);

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      action.setError('El payload debe ser JSON válido.');
      return;
    }
    await action.run(async () => {
      const r = await api.automation.createJob({
        type,
        payload: parsed as Record<string, unknown>,
        ...(key.trim() ? { idempotencyKey: key.trim() } : {}),
      });
      setNote(
        r.created ? 'Trabajo encolado.' : 'Ya existía un trabajo con esa clave: no se duplicó.',
      );
      onCreated();
    });
  };

  return (
    <form className="form inline-form" onSubmit={(e) => void submit(e)}>
      <Field label="Tipo">
        <select
          required
          value={type}
          onChange={(e) => {
            setType(e.target.value);
          }}
        >
          <option value="">Elegir…</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Clave de idempotencia" hint="Opcional: evita duplicados">
        <input
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
          }}
        />
      </Field>
      <Field label="Payload (JSON)">
        <input
          value={payload}
          onChange={(e) => {
            setPayload(e.target.value);
          }}
        />
      </Field>
      <button type="submit" disabled={action.busy}>
        Encolar trabajo
      </button>
      <ErrorText>{action.error}</ErrorText>
      {note && <p className="muted small">{note}</p>}
    </form>
  );
};

/* ---------- Sección ---------- */

export const AutomationSection = () => {
  const clock = useAsync(() => api.automation.clock(), 'clock');
  const types = useAsync(() => api.automation.jobTypes(), 'types');
  const schedules = useAsync(() => api.automation.schedules(), 'schedules');
  const [statusFilter, setStatusFilter] = useState<JobStatus | ''>('');
  const jobs = useAsync(
    () => api.automation.jobs(statusFilter || undefined),
    statusFilter || 'all',
  );
  const breakers = useAsync(() => api.automation.breakers(), 'breakers');
  const tickAction = useAction();
  const [tickResult, setTickResult] = useState<string | null>(null);

  const reloadClock = clock.reload;
  useEffect(() => {
    const t = setInterval(reloadClock, 30_000);
    return () => {
      clearInterval(t);
    };
  }, [reloadClock]);

  const typeNames = types.data?.items.map((t) => t.type) ?? [];
  const serverNow = clock.data?.utc;
  const refreshAll = () => {
    schedules.reload();
    jobs.reload();
    breakers.reload();
    clock.reload();
  };

  const tick = async (which: 'scheduler' | 'recovery') => {
    await tickAction.run(async () => {
      const r = await api.automation.tick(which);
      setTickResult(
        r.ran
          ? `${which === 'scheduler' ? 'Scheduler' : 'Recovery'}: ${Object.entries(r.detail)
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ')}`
          : 'Otro proceso tiene el lock; no se ejecutó.',
      );
      refreshAll();
    });
  };

  return (
    <div className="stack">
      <Panel
        title="Reloj del servidor"
        actions={
          <span className="row-actions">
            <button
              type="button"
              className="ghost"
              disabled={tickAction.busy}
              onClick={() => void tick('scheduler')}
            >
              Ejecutar Scheduler
            </button>
            <button
              type="button"
              className="ghost"
              disabled={tickAction.busy}
              onClick={() => void tick('recovery')}
            >
              Ejecutar Recovery
            </button>
          </span>
        }
      >
        {clock.error && <ErrorText>{clock.error}</ErrorText>}
        {clock.data && (
          <dl className="stats">
            <div>
              <dt>Hora Argentina (servidor)</dt>
              <dd className="big">{formatAr(clock.data.utc)}</dd>
            </div>
            <div>
              <dt>UTC</dt>
              <dd>{clock.data.utc.replace('T', ' ').slice(0, 16)}</dd>
            </div>
            <div>
              <dt>Desfase</dt>
              <dd>UTC{clock.data.offsetMinutes / 60}</dd>
            </div>
            {clock.data.crons.map((c) => (
              <div key={c.name}>
                <dt>{c.name}</dt>
                <dd>
                  <code>{c.expression}</code> UTC
                </dd>
              </div>
            ))}
          </dl>
        )}
        <p className="muted small">
          Las decisiones usan la hora del servidor, no la de este navegador. Los botones de
          ejecución manual existen solo en desarrollo.
        </p>
        <ErrorText>{tickAction.error}</ErrorText>
        {tickResult && <p className="small">{tickResult}</p>}
      </Panel>

      <Panel title="Programaciones">
        <NewSchedule types={typeNames} onCreated={schedules.reload} />
        {schedules.error && <ErrorText>{schedules.error}</ErrorText>}
        {schedules.loading && !schedules.data ? (
          <Loading />
        ) : schedules.data?.items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Programación</th>
                  <th>Frecuencia</th>
                  <th>Próxima (AR)</th>
                  <th>Última (AR)</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {schedules.data.items.map((s) => (
                  <ScheduleRow
                    key={s.id}
                    s={s}
                    serverNow={serverNow}
                    onChanged={schedules.reload}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Sin programaciones. Todas comparten un único Scheduler central.</Empty>
        )}
      </Panel>

      <Panel
        title="Trabajos"
        actions={
          <select
            aria-label="Filtrar por estado"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as JobStatus | '');
            }}
          >
            <option value="">Todos</option>
            {(Object.keys(STATUS_LABEL) as JobStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        }
      >
        <NewJob types={typeNames} onCreated={jobs.reload} />
        {jobs.error && <ErrorText>{jobs.error}</ErrorText>}
        {jobs.loading && !jobs.data ? (
          <Loading />
        ) : jobs.data?.items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Trabajo</th>
                  <th>Estado</th>
                  <th className="num">Prioridad</th>
                  <th className="num">Intentos</th>
                  <th>Ejecutar desde (AR)</th>
                  <th>Último error</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobs.data.items.map((j) => (
                  <JobRow key={j.id} job={j} onChanged={jobs.reload} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Sin trabajos.</Empty>
        )}
      </Panel>

      <Panel title="Circuit breakers">
        {breakers.data?.items.length ? (
          <ul className="list compact">
            {breakers.data.items.map((b) => (
              <li key={b.key}>
                <span>
                  <strong>{b.key}</strong> ·{' '}
                  <Badge tone={b.state === 'CLOSED' ? 'good' : b.state === 'OPEN' ? 'bad' : 'warn'}>
                    {b.state}
                  </Badge>{' '}
                  · {b.consecutiveFailures} fallas seguidas
                  {b.openUntil ? ` · abierto hasta ${formatAr(b.openUntil)}` : ''}
                </span>
                {b.state !== 'CLOSED' && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void api.automation.resetBreaker(b.key).then(breakers.reload)}
                  >
                    Cerrar
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Sin circuit breakers activos.</Empty>
        )}
      </Panel>
    </div>
  );
};

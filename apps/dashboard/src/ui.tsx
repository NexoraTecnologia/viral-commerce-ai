import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from './api-client';
import type { Tone } from './format';

interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Carga asíncrona con recarga manual. `key` identifica qué se carga: cuando
 * cambia (p. ej. otro id), se vuelve a cargar.
 */
export const useAsync = <T,>(load: () => Promise<T>, key: string) => {
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadRef
      .current()
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState((s) => ({ ...s, error: errorMessage(e), loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [key, version]);

  const reload = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);
  return { ...state, reload };
};

/* ---------------- Notificaciones (estados SUCCESS / ERROR) ---------------- */

export interface Toast {
  readonly id: number;
  readonly kind: 'success' | 'error';
  readonly text: string;
}
type ToastListener = (toasts: readonly Toast[]) => void;
let toastList: readonly Toast[] = [];
let toastSeq = 0;
const toastListeners = new Set<ToastListener>();
const emitToasts = () => {
  for (const l of toastListeners) l(toastList);
};

export const notify = (kind: Toast['kind'], text: string) => {
  const id = ++toastSeq;
  toastList = [...toastList, { id, kind, text }].slice(-4);
  emitToasts();
  setTimeout(
    () => {
      toastList = toastList.filter((t) => t.id !== id);
      emitToasts();
    },
    kind === 'error' ? 6000 : 3500,
  );
};

export const ToastStack = () => {
  const [items, setItems] = useState<readonly Toast[]>(toastList);
  useEffect(() => {
    toastListeners.add(setItems);
    return () => {
      toastListeners.delete(setItems);
    };
  }, []);
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span
            className={`dot ${t.kind === 'success' ? 'good' : 'bad'}`}
            style={{ marginTop: 6 }}
          />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
};

/**
 * Ejecuta una acción mostrando estado ocupado, error y confirmación (SUCCESS).
 * `success` = texto de la confirmación; `false` = no mostrarla.
 */
export const useAction = () => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (
      fn: () => Promise<unknown>,
      success: string | false = 'Listo: cambios guardados',
    ): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        if (success) notify('success', success);
        return true;
      } catch (e) {
        const msg = errorMessage(e);
        setError(msg);
        notify('error', msg);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );
  return { busy, error, run, setError };
};

export const Badge = ({ tone, children }: { tone: Tone; children: ReactNode }) => (
  <span className={`badge badge-${tone}`}>{children}</span>
);

export const ErrorText = ({ children }: { children: ReactNode }) =>
  children ? (
    <p className="error" role="alert">
      {children}
    </p>
  ) : null;

export const Field = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </label>
);

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

export const Panel = ({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) => (
  <section className="panel">
    <header className="panel-head">
      <h2>{title}</h2>
      {actions}
    </header>
    {children}
  </section>
);

/* ---------------- Estados LOADING / EMPTY / ERROR ---------------- */

export const Loading = () => (
  <div className="skeleton" aria-busy="true" aria-label="Cargando">
    <span />
    <span />
    <span />
  </div>
);

export const ErrorState = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="state error-state" role="alert">
    <strong>No se pudo cargar</strong>
    <span className="small">{message}</span>
    {onRetry && (
      <button type="button" className="ghost" onClick={onRetry}>
        Reintentar
      </button>
    )}
  </div>
);

export const EmptyState = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="state">
    <strong>{title}</strong>
    {children && <span className="small">{children}</span>}
  </div>
);

/** Renderiza LOADING / ERROR / EMPTY o los datos de un `useAsync`. */
export const AsyncView = <T,>({
  state,
  isEmpty,
  empty,
  children,
}: {
  state: { data: T | null; error: string | null; loading: boolean; reload: () => void };
  isEmpty?: (data: T) => boolean;
  empty: ReactNode;
  children: (data: T) => ReactNode;
}) => {
  if (state.error && state.data === null)
    return <ErrorState message={state.error} onRetry={state.reload} />;
  if (state.data === null) return <Loading />;
  if (isEmpty?.(state.data)) return <>{empty}</>;
  return <>{children(state.data)}</>;
};

/* ---------------- Listas: búsqueda, filtro y paginación ---------------- */

const normalizeSearch = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export interface ListControls<T> {
  readonly query: string;
  readonly setQuery: (q: string) => void;
  readonly filter: string;
  readonly setFilter: (f: string) => void;
  readonly page: number;
  readonly setPage: (p: number) => void;
  readonly pageItems: readonly T[];
  readonly filteredCount: number;
  readonly totalCount: number;
  readonly pages: number;
}

/** Búsqueda de texto + filtro + paginación sobre una lista ya cargada. */
export const useListControls = <T,>(
  items: readonly T[] | undefined,
  opts: {
    text: (item: T) => string;
    filter?: (item: T, value: string) => boolean;
    pageSize?: number;
  },
): ListControls<T> => {
  const [query, setQueryRaw] = useState('');
  const [filter, setFilterRaw] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = opts.pageSize ?? 10;
  const all = items ?? [];
  const q = normalizeSearch(query.trim());
  const filtered = all.filter(
    (it) =>
      (!q || normalizeSearch(opts.text(it)).includes(q)) &&
      (!filter || !opts.filter || opts.filter(it, filter)),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages);
  return {
    query,
    setQuery: (v) => {
      setQueryRaw(v);
      setPage(1);
    },
    filter,
    setFilter: (v) => {
      setFilterRaw(v);
      setPage(1);
    },
    page: current,
    setPage,
    pageItems: filtered.slice((current - 1) * pageSize, current * pageSize),
    filteredCount: filtered.length,
    totalCount: all.length,
    pages,
  };
};

export const ListToolbar = <T,>({
  controls,
  placeholder = 'Buscar…',
  filterLabel,
  filterOptions,
  children,
}: {
  controls: ListControls<T>;
  placeholder?: string;
  filterLabel?: string;
  filterOptions?: readonly { value: string; label: string }[];
  children?: ReactNode;
}) => (
  <div className="toolbar">
    <input
      className="search"
      type="search"
      aria-label={placeholder}
      placeholder={placeholder}
      value={controls.query}
      onChange={(e) => {
        controls.setQuery(e.target.value);
      }}
    />
    {filterOptions && (
      <select
        aria-label={filterLabel ?? 'Filtro'}
        value={controls.filter}
        onChange={(e) => {
          controls.setFilter(e.target.value);
        }}
      >
        <option value="">{filterLabel ?? 'Todos'}</option>
        {filterOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )}
    {children}
  </div>
);

export const Pager = ({
  page,
  pages,
  count,
  total,
  onPage,
}: {
  page: number;
  pages: number;
  count: number;
  total: number;
  onPage: (p: number) => void;
}) => (
  <div className="pager">
    <span>
      {count === total ? `${total} resultado(s)` : `${count} de ${total}`} · página {page} de{' '}
      {pages}
    </span>
    <span className="row-actions">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => {
          onPage(page - 1);
        }}
      >
        Anterior
      </button>
      <button
        type="button"
        disabled={page >= pages}
        onClick={() => {
          onPage(page + 1);
        }}
      >
        Siguiente
      </button>
    </span>
  </div>
);

export const ControlsPager = <T,>({ controls }: { controls: ListControls<T> }) =>
  controls.filteredCount > 0 ? (
    <Pager
      page={controls.page}
      pages={controls.pages}
      count={controls.filteredCount}
      total={controls.totalCount}
      onPage={controls.setPage}
    />
  ) : null;

/* ---------------- Encabezado de página y KPIs ---------------- */

export const PageHeader = ({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) => (
  <div className="page-head">
    <div>
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
    {actions}
  </div>
);

export const Kpi = ({
  label,
  value,
  sub,
  tone,
  href,
}: {
  label: string;
  /** null = sin datos: se muestra "—", nunca un número inventado. */
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'good' | 'bad' | undefined;
  href?: string;
}) => {
  const body = (
    <>
      <div className="kpi-label">{label}</div>
      <div className={value === null ? 'kpi-value dim' : 'kpi-value'}>{value ?? '—'}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </>
  );
  return href ? (
    <a className={`kpi ${tone ?? ''}`} href={href}>
      {body}
    </a>
  ) : (
    <div className={`kpi ${tone ?? ''}`}>{body}</div>
  );
};

/** Pestañas internas de una página. */
export const SubTabs = ({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (id: string) => void;
  options: readonly { id: string; label: string }[];
  label: string;
}) => (
  <nav className="subtabs" aria-label={label}>
    {options.map((o) => (
      <button
        key={o.id}
        type="button"
        className={value === o.id ? 'subtab active' : 'subtab'}
        aria-pressed={value === o.id}
        onClick={() => {
          onChange(o.id);
        }}
      >
        {o.label}
      </button>
    ))}
  </nav>
);

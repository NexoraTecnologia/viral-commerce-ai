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

/** Ejecuta una acción mostrando error y estado ocupado. */
export const useAction = () => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
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

export const Loading = () => <p className="muted">Cargando…</p>;

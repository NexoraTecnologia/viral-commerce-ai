import { useEffect, useState } from 'react';
import type { HealthResponse } from '@vc/shared';
import { fetchHealth } from './api-client';

type ApiState =
  | { status: 'loading' }
  | { status: 'ok'; data: HealthResponse }
  | { status: 'error'; message: string };

export const App = () => {
  const [api, setApi] = useState<ApiState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((data) => {
        setApi({ status: 'ok', data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setApi({ status: 'error', message: error instanceof Error ? error.message : 'Error' });
      });
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <main className="shell">
      <header>
        <h1>ViralCommerce AI</h1>
        <p className="muted">Argentina · Panel de operación (fundación)</p>
      </header>

      <section className="card" aria-live="polite">
        <h2>Estado de la API</h2>
        {api.status === 'loading' && <p>Consultando…</p>}
        {api.status === 'error' && (
          <p className="error">
            No se pudo conectar ({api.message}). ¿Está corriendo <code>npm run dev:api</code>?
          </p>
        )}
        {api.status === 'ok' && (
          <dl>
            <dt>Servicio</dt>
            <dd>{api.data.service}</dd>
            <dt>Versión</dt>
            <dd>{api.data.version}</dd>
            <dt>Entorno</dt>
            <dd>{api.data.environment}</dd>
            <dt>Acciones comerciales</dt>
            <dd>{api.data.commercialActionsEnabled ? 'HABILITADAS' : 'Bloqueadas (simulación)'}</dd>
          </dl>
        )}
      </section>
    </main>
  );
};

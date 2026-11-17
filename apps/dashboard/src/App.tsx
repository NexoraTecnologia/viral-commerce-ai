import { useEffect, useState, type SubmitEvent } from 'react';
import type { HealthResponse, TenantDto } from '@vc/shared';
import { api, errorMessage, fetchHealth, setTenant } from './api-client';
import { AutomationSection } from './sections/Automation';
import { ChannelsSection } from './sections/Channels';
import { DiscoverySection } from './sections/Discovery';
import { ProductsSection } from './sections/Products';
import { ProfitabilitySection } from './sections/Profitability';
import { StockSection } from './sections/Stock';
import { SuppliersSection } from './sections/Suppliers';
import { ErrorText, Field, useAction, useAsync } from './ui';

const TABS = [
  { id: 'proveedores', label: 'Proveedores' },
  { id: 'productos', label: 'Productos' },
  { id: 'stock', label: 'Stock' },
  { id: 'rentabilidad', label: 'Rentabilidad' },
  { id: 'descubrimiento', label: 'Descubrimiento' },
  { id: 'canales', label: 'Canales' },
  { id: 'automatizacion', label: 'Automatización' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const TENANT_KEY = 'vc.tenantId';
const readStored = (): string | null => {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
};
const store = (id: string | null) => {
  try {
    if (id) localStorage.setItem(TENANT_KEY, id);
    else localStorage.removeItem(TENANT_KEY);
  } catch {
    /* almacenamiento no disponible: se pierde al recargar */
  }
};

const tabFromHash = (): TabId => {
  const h = window.location.hash.replace('#', '');
  return TABS.some((t) => t.id === h) ? (h as TabId) : 'proveedores';
};

/** Selector de espacio de trabajo (solo desarrollo, hasta que exista autenticación). */
const WorkspacePicker = ({ onPick }: { onPick: (t: TenantDto) => void }) => {
  const tenants = useAsync(() => api.tenants.list(), 'all');
  const action = useAction();
  const [name, setName] = useState('');
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  const create = async (e: SubmitEvent) => {
    e.preventDefault();
    await action.run(async () => {
      onPick(await api.tenants.create({ name, slug }));
    });
  };

  return (
    <section className="panel narrow">
      <h2>Elegí un espacio de trabajo</h2>
      <p className="muted">Modo desarrollo: todavía no hay inicio de sesión.</p>
      {tenants.error && <ErrorText>{tenants.error}</ErrorText>}
      {tenants.data?.items.length ? (
        <ul className="list">
          {tenants.data.items.map((t) => (
            <li key={t.id}>
              <span>{t.name}</span>
              <button
                type="button"
                onClick={() => {
                  onPick(t);
                }}
              >
                Entrar
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="form inline-form" onSubmit={(e) => void create(e)}>
        <Field label="Nuevo espacio" hint={slug ? `Identificador: ${slug}` : undefined}>
          <input
            required
            minLength={2}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </Field>
        <button type="submit" disabled={action.busy || slug.length < 1}>
          Crear
        </button>
      </form>
      <ErrorText>{action.error}</ErrorText>
    </section>
  );
};

export const App = () => {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(() => {
    const stored = readStored();
    setTenant(stored);
    return stored;
  });
  const [tab, setTab] = useState<TabId>(tabFromHash);

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((h) => {
        setHealth(h);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setHealthError(errorMessage(e));
      });
    const onHash = () => {
      setTab(tabFromHash());
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      controller.abort();
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  const pick = (id: string | null) => {
    setTenant(id);
    store(id);
    setTenantId(id);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>ViralCommerce AI</h1>
          <p className="muted small">
            {health
              ? `API ${health.version} · ${health.environment} · acciones comerciales ${health.commercialActionsEnabled ? 'HABILITADAS' : 'bloqueadas (simulación)'}`
              : healthError
                ? 'API sin conexión — ¿está corriendo npm run dev:api?'
                : 'Conectando…'}
          </p>
        </div>
        {tenantId && (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              pick(null);
            }}
          >
            Cambiar espacio
          </button>
        )}
      </header>

      {!tenantId ? (
        <WorkspacePicker
          onPick={(t) => {
            pick(t.id);
          }}
        />
      ) : (
        <>
          <nav className="tabs" aria-label="Secciones">
            {TABS.map((t) => (
              <a
                key={t.id}
                href={`#${t.id}`}
                className={tab === t.id ? 'tab active' : 'tab'}
                aria-current={tab === t.id ? 'page' : undefined}
              >
                {t.label}
              </a>
            ))}
          </nav>
          <main key={tenantId}>
            {tab === 'proveedores' && <SuppliersSection />}
            {tab === 'productos' && <ProductsSection />}
            {tab === 'stock' && <StockSection />}
            {tab === 'rentabilidad' && <ProfitabilitySection />}
            {tab === 'descubrimiento' && <DiscoverySection />}
            {tab === 'canales' && <ChannelsSection />}
            {tab === 'automatizacion' && <AutomationSection />}
          </main>
        </>
      )}
    </div>
  );
};

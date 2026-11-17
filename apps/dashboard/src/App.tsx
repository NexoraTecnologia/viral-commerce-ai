import { useEffect, useState, type ReactNode, type SubmitEvent } from 'react';
import type { HealthResponse, TenantDto } from '@vc/shared';
import { api, errorMessage, fetchHealth, setTenant } from './api-client';
import { Icon, type IconName } from './icons';
import { AgentsPage, AuditPage, FinancePage, RulesPage, SettingsPage } from './pages/Governance';
import { CustomersPage, ShipmentsPage } from './pages/Operations';
import { OverviewPage } from './pages/Overview';
import { AutomationSection } from './sections/Automation';
import {
  AffiliatesView,
  ChannelOrdersView,
  ConnectionsView,
  ListingsView,
  LogView,
} from './sections/Channels';
import { DiscoverySection } from './sections/Discovery';
import { OrdersView, SimulationsView } from './sections/Orders';
import { ProductsSection } from './sections/Products';
import { StockSection } from './sections/Stock';
import { SuppliersSection } from './sections/Suppliers';
import { ErrorText, Field, PageHeader, SubTabs, ToastStack, useAction, useAsync } from './ui';

/* ================================ Navegación ================================ */

interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  readonly group: string;
}

const NAV: readonly NavItem[] = [
  { id: 'overview', label: 'Overview', icon: 'overview', group: 'General' },
  { id: 'radar', label: 'Radar de productos', icon: 'radar', group: 'Producto' },
  { id: 'catalogo', label: 'Catálogo', icon: 'catalog', group: 'Producto' },
  { id: 'proveedores', label: 'Proveedores', icon: 'suppliers', group: 'Producto' },
  { id: 'inventario', label: 'Inventario de proveedores', icon: 'inventory', group: 'Producto' },
  { id: 'publicaciones', label: 'Publicaciones', icon: 'listings', group: 'Ventas' },
  { id: 'pedidos', label: 'Pedidos', icon: 'orders', group: 'Ventas' },
  { id: 'envios', label: 'Envíos', icon: 'shipments', group: 'Ventas' },
  { id: 'clientes', label: 'Clientes', icon: 'customers', group: 'Ventas' },
  { id: 'afiliados', label: 'Afiliados', icon: 'affiliates', group: 'Ventas' },
  { id: 'finanzas', label: 'Finanzas', icon: 'finance', group: 'Control' },
  { id: 'automatizaciones', label: 'Automatizaciones', icon: 'automation', group: 'Control' },
  { id: 'agentes', label: 'Agentes', icon: 'agents', group: 'Control' },
  { id: 'integraciones', label: 'Integraciones', icon: 'integrations', group: 'Control' },
  { id: 'reglas', label: 'Reglas', icon: 'rules', group: 'Control' },
  { id: 'auditoria', label: 'Auditoría', icon: 'audit', group: 'Control' },
  { id: 'configuracion', label: 'Configuración', icon: 'settings', group: 'Control' },
];

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

/** Alias de las rutas anteriores para no romper enlaces guardados. */
const LEGACY: Record<string, string> = {
  descubrimiento: 'radar',
  productos: 'catalogo',
  stock: 'inventario',
  rentabilidad: 'finanzas',
  canales: 'integraciones',
  automatizacion: 'automatizaciones',
};

const pageFromHash = (): string => {
  const raw = window.location.hash.replace('#', '');
  const h = LEGACY[raw] ?? raw;
  return NAV.some((n) => n.id === h) ? h : 'overview';
};

/* ================================ Páginas envoltorio ================================ */

const Section = ({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) => (
  <div className="stack">
    <PageHeader title={title} description={description} />
    {children}
  </div>
);

const OrdersPage = () => {
  const [view, setView] = useState('pedidos');
  return (
    <Section
      title="Pedidos"
      description="Recepción, pago, stock, proveedor, finanzas, despacho, devoluciones y conciliación. Cada estado exige su evidencia."
    >
      <SubTabs
        value={view}
        onChange={setView}
        label="Pedidos"
        options={[
          { id: 'pedidos', label: 'Pedidos' },
          { id: 'canal', label: 'Pedidos de canales' },
          { id: 'simulaciones', label: 'Simulaciones' },
        ]}
      />
      {view === 'pedidos' && <OrdersView />}
      {view === 'canal' && <ChannelOrdersView />}
      {view === 'simulaciones' && <SimulationsView />}
    </Section>
  );
};

const IntegrationsPage = () => {
  const [view, setView] = useState('conexiones');
  return (
    <Section
      title="Integraciones"
      description="Conexiones a Mercado Libre, Instagram, WhatsApp, tienda propia y afiliados, en modo LIVE (API oficial) o MOCK (simulado)."
    >
      <SubTabs
        value={view}
        onChange={setView}
        label="Integraciones"
        options={[
          { id: 'conexiones', label: 'Configurar canales' },
          { id: 'registro', label: 'Registro y webhooks' },
        ]}
      />
      {view === 'conexiones' && <ConnectionsView />}
      {view === 'registro' && <LogView />}
    </Section>
  );
};

const renderPage = (id: string, onSwitchWorkspace: () => void): ReactNode => {
  switch (id) {
    case 'overview':
      return <OverviewPage />;
    case 'radar':
      return (
        <Section
          title="Radar de productos"
          description="Investigación con datos observados, puntaje 0–100, Risk Guardian y contenido."
        >
          <DiscoverySection />
        </Section>
      );
    case 'catalogo':
      return (
        <Section
          title="Catálogo"
          description="Productos propios, costos y ofertas de proveedores vinculadas."
        >
          <ProductsSection />
        </Section>
      );
    case 'proveedores':
      return (
        <Section
          title="Proveedores"
          description="Alta, evidencia, verificación y puntaje de proveedores con despacho directo."
        >
          <SuppliersSection />
        </Section>
      );
    case 'inventario':
      return (
        <Section
          title="Inventario de proveedores"
          description="Precio mayorista y controles de stock por oferta, con su fuente y antigüedad."
        >
          <StockSection />
        </Section>
      );
    case 'publicaciones':
      return (
        <Section
          title="Publicaciones"
          description="Revisá cada publicación y sus condiciones. Publicar exige todas las condiciones y el interruptor comercial."
        >
          <ListingsView />
        </Section>
      );
    case 'pedidos':
      return <OrdersPage />;
    case 'envios':
      return <ShipmentsPage />;
    case 'clientes':
      return <CustomersPage />;
    case 'afiliados':
      return (
        <Section
          title="Afiliados"
          description="Redes, productos, enlaces de seguimiento, clics, conversiones y comisiones con respaldo."
        >
          <AffiliatesView />
        </Section>
      );
    case 'finanzas':
      return <FinancePage />;
    case 'automatizaciones':
      return (
        <Section
          title="Automatizaciones"
          description="Programaciones, cola de trabajos, reintentos y circuit breakers (hora de Argentina)."
        >
          <AutomationSection />
        </Section>
      );
    case 'agentes':
      return <AgentsPage />;
    case 'integraciones':
      return <IntegrationsPage />;
    case 'reglas':
      return <RulesPage />;
    case 'auditoria':
      return <AuditPage />;
    case 'configuracion':
      return <SettingsPage onSwitchWorkspace={onSwitchWorkspace} />;
    default:
      return <OverviewPage />;
  }
};

/* ================================ Selector de espacio ================================ */

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
    }, 'Espacio creado');
  };

  return (
    <section className="panel narrow">
      <div className="brand">
        <div className="brand-mark">VC</div>
        <div className="brand-text">
          <div className="brand-name">VIRALCOMMERCE AI</div>
          <div className="brand-sub">ARGENTINA</div>
        </div>
      </div>
      <h2>Elegí un espacio de trabajo</h2>
      <p className="muted small">Modo desarrollo: todavía no hay inicio de sesión.</p>
      {tenants.error && <ErrorText>{tenants.error}</ErrorText>}
      {tenants.data?.items.length ? (
        <ul className="list" style={{ marginTop: 12 }}>
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

/* ================================ Aplicación ================================ */

export const App = () => {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(() => {
    const stored = readStored();
    setTenant(stored);
    return stored;
  });
  const [page, setPage] = useState(pageFromHash);
  const [menuOpen, setMenuOpen] = useState(false);

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
      setPage(pageFromHash());
      setMenuOpen(false);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      controller.abort();
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const pick = (id: string | null) => {
    setTenant(id);
    store(id);
    setTenantId(id);
  };

  if (!tenantId) {
    return (
      <div className="content">
        <WorkspacePicker
          onPick={(t) => {
            pick(t.id);
          }}
        />
        <ToastStack />
      </div>
    );
  }

  const current = NAV.find((n) => n.id === page) ?? NAV[0];
  const groups = [...new Set(NAV.map((n) => n.group))];

  return (
    <div className="app">
      <aside className={menuOpen ? 'sidebar open' : 'sidebar'} aria-label="Menú principal">
        <div className="brand">
          <div className="brand-mark">VC</div>
          <div className="brand-text">
            <div className="brand-name">VIRALCOMMERCE AI</div>
            <div className="brand-sub">ARGENTINA</div>
          </div>
        </div>
        <nav>
          {groups.map((g) => (
            <div key={g}>
              <div className="nav-group">{g}</div>
              {NAV.filter((n) => n.group === g).map((n) => (
                <a
                  key={n.id}
                  href={`#${n.id}`}
                  className={n.id === page ? 'nav-item active' : 'nav-item'}
                  aria-current={n.id === page ? 'page' : undefined}
                >
                  <Icon name={n.icon} />
                  <span>{n.label}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot small muted">
          {health
            ? `API ${health.version} · ${health.environment}`
            : healthError
              ? 'API sin conexión'
              : 'Conectando…'}
        </div>
      </aside>
      <div
        className={menuOpen ? 'backdrop open' : 'backdrop'}
        onClick={() => {
          setMenuOpen(false);
        }}
        aria-hidden="true"
      />
      <div className="main">
        <header className="appbar">
          <button
            type="button"
            className="icon-btn menu-btn"
            aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((o) => !o);
            }}
          >
            <Icon name={menuOpen ? 'close' : 'menu'} />
          </button>
          <strong className="small">{current?.label}</strong>
          <span className="spacer" />
          {health ? (
            <span className="status-pill" title="Interruptor maestro de acciones comerciales">
              <span className={health.commercialActionsEnabled ? 'dot bad' : 'dot good'} />
              <span className="hide-mobile">Acciones comerciales:</span>
              {health.commercialActionsEnabled ? ' habilitadas' : ' simulación'}
            </span>
          ) : (
            <span className="status-pill">
              <span className={healthError ? 'dot bad' : 'dot warn'} />
              {healthError ? 'API sin conexión' : 'Conectando…'}
            </span>
          )}
          <a className="status-pill hide-mobile" href="#configuracion">
            Espacio de trabajo
          </a>
        </header>
        <main className="content" key={tenantId}>
          {healthError && (
            <p className="notice">
              La API no responde: ¿está corriendo <code>npm run dev:api</code>?
            </p>
          )}
          {renderPage(page, () => {
            pick(null);
          })}
        </main>
      </div>
      <ToastStack />
    </div>
  );
};

import { appError, err, type Result, type SourceKind, type SourceStatus } from '@vc/shared';

/**
 * Adaptadores intercambiables de fuentes de investigación.
 *
 * Cada fuente externa se conecta implementando `DiscoveryAdapter`. Mientras no
 * exista un conector real con acceso autorizado, la fuente queda NOT_CONFIGURED:
 * no devuelve datos, no simula demanda y no genera estadísticas.
 */
export interface DiscoverySignal {
  readonly title: string;
  /** URL o identificador verificable en la fuente. */
  readonly sourceRef: string;
  readonly observedAt: Date;
  readonly supplierProductId?: string;
}

export interface AdapterStatus {
  readonly status: SourceStatus;
  readonly detail: string;
}

export interface DiscoveryQuery {
  readonly tenantId: string;
  readonly keywords?: readonly string[];
}

export interface DiscoveryAdapter {
  readonly kind: SourceKind;
  status(): AdapterStatus;
  fetchSignals(query: DiscoveryQuery): Promise<Result<readonly DiscoverySignal[]>>;
}

/** Adaptador de una fuente sin conector: siempre NOT_CONFIGURED, nunca datos. */
export const notConfiguredAdapter = (kind: SourceKind, detail: string): DiscoveryAdapter => ({
  kind,
  status: () => ({ status: 'NOT_CONFIGURED', detail }),
  fetchSignals: () =>
    Promise.resolve(
      err(appError('INTEGRATION_NOT_CONFIGURED', `Fuente ${kind} no configurada: ${detail}`)),
    ),
});

/** Fuente manual: los datos los carga una persona desde el dashboard, con fuente y fecha. */
export const manualAdapter: DiscoveryAdapter = {
  kind: 'MANUAL',
  status: () => ({ status: 'CONFIGURED', detail: 'Carga manual desde el dashboard' }),
  fetchSignals: () =>
    Promise.resolve(
      err(
        appError(
          'VALIDATION_ERROR',
          'La fuente manual no se sincroniza: los datos se cargan a mano',
        ),
      ),
    ),
};

export const DEFAULT_NOT_CONFIGURED_DETAIL: Record<
  Exclude<SourceKind, 'MANUAL' | 'SUPPLIER_CATALOG'>,
  string
> = {
  GOOGLE_TRENDS:
    'Sin conector. Requiere acceso oficial autorizado a Google Trends; no se hace scraping.',
  PUBLIC_SOURCE:
    'Sin conector. Cada fuente pública necesita revisar sus términos de uso antes de integrarla.',
  COMMERCIAL_API: 'Sin conector. Requiere credenciales y contrato de una API comercial autorizada.',
};

/**
 * Registro de adaptadores por tipo de fuente. Los no provistos quedan NOT_CONFIGURED.
 * Para conectar una fuente real basta con pasar su adaptador aquí.
 */
export const createDiscoveryAdapters = (
  connected: Partial<Record<SourceKind, DiscoveryAdapter>> = {},
): Readonly<Record<SourceKind, DiscoveryAdapter>> => ({
  GOOGLE_TRENDS:
    connected.GOOGLE_TRENDS ??
    notConfiguredAdapter('GOOGLE_TRENDS', DEFAULT_NOT_CONFIGURED_DETAIL.GOOGLE_TRENDS),
  PUBLIC_SOURCE:
    connected.PUBLIC_SOURCE ??
    notConfiguredAdapter('PUBLIC_SOURCE', DEFAULT_NOT_CONFIGURED_DETAIL.PUBLIC_SOURCE),
  COMMERCIAL_API:
    connected.COMMERCIAL_API ??
    notConfiguredAdapter('COMMERCIAL_API', DEFAULT_NOT_CONFIGURED_DETAIL.COMMERCIAL_API),
  SUPPLIER_CATALOG:
    connected.SUPPLIER_CATALOG ??
    notConfiguredAdapter('SUPPLIER_CATALOG', 'Catálogo de proveedores no conectado'),
  MANUAL: connected.MANUAL ?? manualAdapter,
});

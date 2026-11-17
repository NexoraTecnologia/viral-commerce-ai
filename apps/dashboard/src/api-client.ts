import { z } from 'zod';
import {
  AnalysisDtoSchema,
  CategoryDtoSchema,
  CompetitorDtoSchema,
  DiscoveredProductDetailDtoSchema,
  DiscoveredProductDtoSchema,
  GeneratedContentDtoSchema,
  SourceDtoSchema,
  SourceSyncResultSchema,
  type CreateCategoryRequest,
  type CreateCompetitorRequest,
  type CreateDiscoveredProductRequest,
  type CreateSourceRequest,
  type DiscoveryStatus,
  type RecordAttributeRequest,
  type RecordDemandObservationRequest,
  type RecordImageRequest,
  type RecordPriceObservationRequest,
  type UpdateDiscoveredProductRequest,
  CircuitBreakerDtoSchema,
  CreateJobResponseSchema,
  ErrorResponseSchema,
  EvidenceDtoSchema,
  FinancialGuardResultSchema,
  HealthResponseSchema,
  InventorySnapshotDtoSchema,
  JobDetailDtoSchema,
  JobDtoSchema,
  JobTypeDtoSchema,
  listOf,
  ProductCostDtoSchema,
  ProductDtoSchema,
  ProfitBreakdownSchema,
  ProfitCalculationDtoSchema,
  ScheduleDtoSchema,
  ServerClockDtoSchema,
  SupplierDetailDtoSchema,
  SupplierDtoSchema,
  SupplierProductDtoSchema,
  TenantDtoSchema,
  TickResultDtoSchema,
  type ChangeSupplierStatusRequest,
  type CostComponent,
  type CreateJobRequest,
  type CreateProductRequest,
  type CreateScheduleRequest,
  type CreateSupplierProductRequest,
  type CreateSupplierRequest,
  type CreateTenantRequest,
  type FinancialGuardRequest,
  type HealthResponse,
  type JobStatus,
  type ProfitSimulationRequest,
  type RecordEvidenceRequest,
  type RecordInventoryRequest,
  type ReviewEvidenceRequest,
  type UpdateScheduleRequest,
  type UpdateSupplierPriceRequest,
} from '@vc/shared';

export const buildApiUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

const apiBase = (): string => import.meta.env.VITE_API_BASE_URL ?? '/api';

/** Error de la API con el código estándar y los detalles de validación. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let tenantId: string | null = null;
export const setTenant = (id: string | null) => {
  tenantId = id;
};

/** Toda respuesta se valida con Zod contra el contrato compartido. */
const request = async <S extends z.ZodType>(
  path: string,
  schema: S,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<z.output<S>> => {
  const headers: Record<string, string> = {};
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(buildApiUrl(apiBase(), path), {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ErrorResponseSchema.safeParse(json);
    throw parsed.success
      ? new ApiError(
          res.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.details,
        )
      : new ApiError(res.status, 'HTTP_ERROR', `La API respondió ${res.status}`);
  }
  return schema.parse(json);
};

const post = <S extends z.ZodType>(path: string, schema: S, body: unknown) =>
  request(path, schema, { method: 'POST', body });
const patch = <S extends z.ZodType>(path: string, schema: S, body: unknown) =>
  request(path, schema, { method: 'PATCH', body });

export const fetchHealth = (signal?: AbortSignal): Promise<HealthResponse> =>
  request('/health', HealthResponseSchema, signal ? { signal } : {});

const idOnly = z.object({ id: z.uuid() });

export const api = {
  discovery: {
    sources: () => request('/v1/discovery/sources', listOf(SourceDtoSchema)),
    createSource: (body: CreateSourceRequest) =>
      post('/v1/discovery/sources', SourceDtoSchema, body),
    syncSource: (id: string) =>
      post(`/v1/discovery/sources/${id}/sync`, SourceSyncResultSchema, {}),
    categories: () => request('/v1/discovery/categories', listOf(CategoryDtoSchema)),
    createCategory: (body: CreateCategoryRequest) =>
      post('/v1/discovery/categories', CategoryDtoSchema, body),
    competitors: () => request('/v1/discovery/competitors', listOf(CompetitorDtoSchema)),
    createCompetitor: (body: CreateCompetitorRequest) =>
      post('/v1/discovery/competitors', CompetitorDtoSchema, body),
    radar: () => request('/v1/discovery/radar', listOf(DiscoveredProductDtoSchema)),
    products: (status: DiscoveryStatus) =>
      request(`/v1/discovery/products?status=${status}`, listOf(DiscoveredProductDtoSchema)),
    product: (id: string) =>
      request(`/v1/discovery/products/${id}`, DiscoveredProductDetailDtoSchema),
    createProduct: (body: CreateDiscoveredProductRequest) =>
      post('/v1/discovery/products', DiscoveredProductDtoSchema, body),
    updateProduct: (id: string, body: UpdateDiscoveredProductRequest) =>
      patch(`/v1/discovery/products/${id}`, DiscoveredProductDtoSchema, body),
    classify: (id: string) =>
      post(`/v1/discovery/products/${id}/classify`, DiscoveredProductDtoSchema, {}),
    recordDemand: (id: string, body: RecordDemandObservationRequest) =>
      post(`/v1/discovery/products/${id}/demand`, idOnly, body),
    recordPrice: (id: string, body: RecordPriceObservationRequest) =>
      post(`/v1/discovery/products/${id}/prices`, idOnly, body),
    recordAttribute: (id: string, body: RecordAttributeRequest) =>
      post(`/v1/discovery/products/${id}/attributes`, idOnly, body),
    recordImage: (id: string, body: RecordImageRequest) =>
      post(`/v1/discovery/products/${id}/images`, idOnly, body),
    analyze: (id: string) => post(`/v1/discovery/products/${id}/analyze`, AnalysisDtoSchema, {}),
    promote: (id: string) =>
      post(
        `/v1/discovery/products/${id}/promote`,
        z.object({ product: DiscoveredProductDtoSchema, analysis: AnalysisDtoSchema }),
        {},
      ),
    discard: (id: string, reason: string) =>
      post(`/v1/discovery/products/${id}/discard`, DiscoveredProductDtoSchema, { reason }),
    reopen: (id: string) =>
      post(`/v1/discovery/products/${id}/reopen`, DiscoveredProductDtoSchema, {}),
    generateContent: (id: string) =>
      post(`/v1/discovery/products/${id}/content`, GeneratedContentDtoSchema, {}),
    contents: () => request('/v1/discovery/content', listOf(GeneratedContentDtoSchema)),
  },
  automation: {
    clock: () => request('/v1/automation/clock', ServerClockDtoSchema),
    jobTypes: () => request('/v1/automation/job-types', listOf(JobTypeDtoSchema)),
    jobs: (status?: JobStatus) =>
      request(
        status ? `/v1/automation/jobs?status=${status}` : '/v1/automation/jobs',
        listOf(JobDtoSchema),
      ),
    job: (id: string) => request(`/v1/automation/jobs/${id}`, JobDetailDtoSchema),
    createJob: (body: CreateJobRequest) =>
      post('/v1/automation/jobs', CreateJobResponseSchema, body),
    cancelJob: (id: string) => post(`/v1/automation/jobs/${id}/cancel`, JobDtoSchema, {}),
    retryJob: (id: string) => post(`/v1/automation/jobs/${id}/retry`, JobDtoSchema, {}),
    schedules: () => request('/v1/automation/schedules', listOf(ScheduleDtoSchema)),
    createSchedule: (body: CreateScheduleRequest) =>
      post('/v1/automation/schedules', ScheduleDtoSchema, body),
    updateSchedule: (id: string, body: UpdateScheduleRequest) =>
      patch(`/v1/automation/schedules/${id}`, ScheduleDtoSchema, body),
    breakers: () => request('/v1/automation/circuit-breakers', listOf(CircuitBreakerDtoSchema)),
    resetBreaker: (key: string) =>
      post(
        `/v1/automation/circuit-breakers/${encodeURIComponent(key)}/reset`,
        z.object({ key: z.string(), state: z.string() }),
        {},
      ),
    tick: (which: 'scheduler' | 'recovery') =>
      post(`/v1/automation/tick/${which}`, TickResultDtoSchema, {}),
  },
  tenants: {
    list: () => request('/v1/tenants', listOf(TenantDtoSchema)),
    create: (body: CreateTenantRequest) => post('/v1/tenants', TenantDtoSchema, body),
  },
  suppliers: {
    list: () => request('/v1/suppliers', listOf(SupplierDtoSchema)),
    get: (id: string) => request(`/v1/suppliers/${id}`, SupplierDetailDtoSchema),
    create: (body: CreateSupplierRequest) => post('/v1/suppliers', SupplierDtoSchema, body),
    recordEvidence: (id: string, body: RecordEvidenceRequest) =>
      post(`/v1/suppliers/${id}/evidence`, EvidenceDtoSchema, body),
    reviewEvidence: (id: string, evidenceId: string, body: ReviewEvidenceRequest) =>
      post(`/v1/suppliers/${id}/evidence/${evidenceId}/review`, EvidenceDtoSchema, body),
    changeStatus: (id: string, body: ChangeSupplierStatusRequest) =>
      post(`/v1/suppliers/${id}/status`, SupplierDtoSchema, body),
  },
  products: {
    list: () => request('/v1/products', listOf(ProductDtoSchema)),
    create: (body: CreateProductRequest) => post('/v1/products', ProductDtoSchema, body),
    costs: (id: string) => request(`/v1/products/${id}/costs`, listOf(ProductCostDtoSchema)),
    addCost: (id: string, body: CostComponent) =>
      post(`/v1/products/${id}/costs`, ProductCostDtoSchema, body),
    deleteCost: (id: string, costId: string) =>
      request(`/v1/products/${id}/costs/${costId}`, z.object({ deleted: z.literal(true) }), {
        method: 'DELETE',
      }),
  },
  offers: {
    list: (productId?: string) =>
      request(
        productId ? `/v1/supplier-products?productId=${productId}` : '/v1/supplier-products',
        listOf(SupplierProductDtoSchema),
      ),
    create: (body: CreateSupplierProductRequest) =>
      post('/v1/supplier-products', SupplierProductDtoSchema, body),
    updatePrice: (id: string, body: UpdateSupplierPriceRequest) =>
      patch(`/v1/supplier-products/${id}/price`, SupplierProductDtoSchema, body),
    recordInventory: (id: string, body: RecordInventoryRequest) =>
      post(`/v1/supplier-products/${id}/inventory`, InventorySnapshotDtoSchema, body),
  },
  profit: {
    list: () => request('/v1/profit-calculations', listOf(ProfitCalculationDtoSchema)),
    calculate: (productId: string, supplierProductId: string) =>
      post(`/v1/products/${productId}/profit-calculations`, ProfitCalculationDtoSchema, {
        supplierProductId,
      }),
    simulate: (body: ProfitSimulationRequest) =>
      post('/v1/profit/simulate', ProfitBreakdownSchema, body),
    financialGuard: (body: FinancialGuardRequest) =>
      post('/v1/financial-guard/evaluate', FinancialGuardResultSchema, body),
  },
};

/** Mensaje legible para mostrar en UI. */
export const errorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (Array.isArray(error.details)) {
      const first = error.details[0] as { path?: string; message?: string } | undefined;
      if (first?.message)
        return `${error.message}: ${first.path ? `${first.path} — ` : ''}${first.message}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'Error inesperado';
};

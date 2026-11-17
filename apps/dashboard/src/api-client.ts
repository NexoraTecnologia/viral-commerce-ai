import { z } from 'zod';
import {
  ErrorResponseSchema,
  EvidenceDtoSchema,
  FinancialGuardResultSchema,
  HealthResponseSchema,
  InventorySnapshotDtoSchema,
  listOf,
  ProductCostDtoSchema,
  ProductDtoSchema,
  ProfitBreakdownSchema,
  ProfitCalculationDtoSchema,
  SupplierDetailDtoSchema,
  SupplierDtoSchema,
  SupplierProductDtoSchema,
  TenantDtoSchema,
  type ChangeSupplierStatusRequest,
  type CostComponent,
  type CreateProductRequest,
  type CreateSupplierProductRequest,
  type CreateSupplierRequest,
  type CreateTenantRequest,
  type FinancialGuardRequest,
  type HealthResponse,
  type ProfitSimulationRequest,
  type RecordEvidenceRequest,
  type RecordInventoryRequest,
  type ReviewEvidenceRequest,
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

export const api = {
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

import { HealthResponseSchema, type HealthResponse } from '@vc/shared';

export const buildApiUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

const apiBase = (): string => import.meta.env.VITE_API_BASE_URL ?? '/api';

/** Cliente mínimo: toda respuesta se valida con Zod contra el contrato compartido. */
export const fetchHealth = async (signal?: AbortSignal): Promise<HealthResponse> => {
  const res = await fetch(buildApiUrl(apiBase(), '/health'), signal ? { signal } : {});
  if (!res.ok) throw new Error(`API respondió ${res.status}`);
  return HealthResponseSchema.parse(await res.json());
};

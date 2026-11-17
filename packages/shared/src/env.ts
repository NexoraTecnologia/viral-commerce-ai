import { z } from 'zod';

/** Representación de booleanos en variables de entorno ("true" / "false"). */
const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

/** Entero desde string de entorno, con rango. */
const intString = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

/**
 * Variables de configuración NO secretas del Worker de la API.
 * Los secretos se declaran aparte y se cargan con `wrangler secret put`.
 *
 * Los umbrales son POLÍTICA (reglas de decisión), no datos financieros.
 */
export const ApiConfigSchema = z.object({
  /**
   * FAIL-CLOSED: si falta, se asume producción (sin el header temporal de tenant).
   * El modo desarrollo se activa explícitamente (`npm run dev:api` usa --var).
   */
  APP_ENV: z.enum(['development', 'staging', 'production']).default('production'),
  /** Lista de orígenes permitidos para CORS separados por coma. */
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  /**
   * Interruptor maestro de acciones comerciales reales (publicar, comprar,
   * cobrar, contactar proveedores). Debe permanecer en "false" hasta que el
   * roadmap lo habilite explícitamente.
   */
  COMMERCIAL_ACTIONS_ENABLED: booleanString,
  /** Margen neto mínimo en basis points (2000 = 20 %). */
  MIN_NET_MARGIN_BPS: intString(2000, 0, 9999),
  /** Antigüedad máxima del precio mayorista antes de considerarlo desactualizado. */
  MAX_PRICE_AGE_HOURS: intString(72, 1, 24 * 90),
  /** Antigüedad máxima del último control de stock. */
  MAX_STOCK_AGE_HOURS: intString(24, 1, 24 * 30),
  /** Antigüedad máxima del dato de fondos disponibles para el Financial Guard. */
  MAX_FUNDS_DATA_AGE_HOURS: intString(24, 1, 24 * 7),
  /** Riesgo de devolución máximo aceptado (bps). */
  MAX_RETURN_RISK_BPS: intString(1500, 0, 10000),
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export const parseApiConfig = (raw: Record<string, unknown>): ApiConfig =>
  ApiConfigSchema.parse(raw);

import { z } from 'zod';

/** Representación de booleanos en variables de entorno ("true" / "false"). */
const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

/**
 * Variables de configuración NO secretas del Worker de la API.
 * Los secretos se declaran aparte y se cargan con `wrangler secret put`.
 */
export const ApiConfigSchema = z.object({
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  /** Lista de orígenes permitidos para CORS separados por coma. */
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  /**
   * Interruptor maestro de acciones comerciales reales (publicar, comprar,
   * cobrar, contactar proveedores). Debe permanecer en "false" hasta que el
   * roadmap lo habilite explícitamente.
   */
  COMMERCIAL_ACTIONS_ENABLED: booleanString,
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export const parseApiConfig = (raw: Record<string, unknown>): ApiConfig =>
  ApiConfigSchema.parse(raw);

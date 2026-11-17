import type { Database } from '@vc/database';
import type { QueueMessage } from '@vc/queue';
import type { ApiConfig } from '@vc/shared';

/** Bindings declarados en wrangler.jsonc. Mantener sincronizado. */
export interface Env {
  readonly DB: D1Database;
  readonly JOBS_QUEUE: Queue<QueueMessage>;
  readonly APP_ENV: string;
  readonly ALLOWED_ORIGINS: string;
  readonly COMMERCIAL_ACTIONS_ENABLED: string;
  readonly MIN_NET_MARGIN_BPS?: string;
  readonly MAX_PRICE_AGE_HOURS?: string;
  readonly MAX_STOCK_AGE_HOURS?: string;
  readonly MAX_FUNDS_DATA_AGE_HOURS?: string;
  readonly MAX_RETURN_RISK_BPS?: string;
}

/** Contexto por request disponible tras el middleware de tenant. */
export interface RequestVariables {
  tenantId: string;
  db: Database;
  config: ApiConfig;
}

export interface AppBindings {
  Bindings: Env;
  Variables: RequestVariables;
}

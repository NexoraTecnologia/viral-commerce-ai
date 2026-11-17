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
  /* ---- Secrets de integraciones (wrangler secret put / .dev.vars). Todos opcionales:
         si faltan, el canal queda NOT_CONFIGURED. Nunca se commitean. ---- */
  /** 32 bytes en base64 para cifrar tokens (AES-256-GCM). */
  readonly TOKEN_ENCRYPTION_KEY?: string;
  /** URL pública de esta API (para armar redirect_uri de OAuth). */
  readonly PUBLIC_API_URL?: string;
  readonly ML_APP_ID?: string;
  readonly ML_CLIENT_SECRET?: string;
  readonly INSTAGRAM_APP_ID?: string;
  readonly INSTAGRAM_APP_SECRET?: string;
  /** App Secret de la app de Meta que recibe los webhooks de WhatsApp. */
  readonly META_APP_SECRET?: string;
  /** Verify token elegido al suscribir los webhooks de Meta. */
  readonly META_WEBHOOK_VERIFY_TOKEN?: string;
}

/** Secrets de integraciones que necesitan los servicios y los trabajos. */
export interface ChannelSecrets {
  readonly TOKEN_ENCRYPTION_KEY?: string | undefined;
  readonly PUBLIC_API_URL?: string | undefined;
  readonly ML_APP_ID?: string | undefined;
  readonly ML_CLIENT_SECRET?: string | undefined;
  readonly INSTAGRAM_APP_ID?: string | undefined;
  readonly INSTAGRAM_APP_SECRET?: string | undefined;
  readonly META_APP_SECRET?: string | undefined;
  readonly META_WEBHOOK_VERIFY_TOKEN?: string | undefined;
}

export const secretsFromEnv = (env: Env): ChannelSecrets => ({
  TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY,
  PUBLIC_API_URL: env.PUBLIC_API_URL,
  ML_APP_ID: env.ML_APP_ID,
  ML_CLIENT_SECRET: env.ML_CLIENT_SECRET,
  INSTAGRAM_APP_ID: env.INSTAGRAM_APP_ID,
  INSTAGRAM_APP_SECRET: env.INSTAGRAM_APP_SECRET,
  META_APP_SECRET: env.META_APP_SECRET,
  META_WEBHOOK_VERIFY_TOKEN: env.META_WEBHOOK_VERIFY_TOKEN,
});

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

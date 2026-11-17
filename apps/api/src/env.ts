import type { QueueMessage } from '@vc/queue';

/** Bindings declarados en wrangler.jsonc. Mantener sincronizado. */
export interface Env {
  readonly DB: D1Database;
  readonly JOBS_QUEUE: Queue<QueueMessage>;
  readonly APP_ENV: string;
  readonly ALLOWED_ORIGINS: string;
  readonly COMMERCIAL_ACTIONS_ENABLED: string;
}

export interface AppBindings {
  Bindings: Env;
}

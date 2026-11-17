import { createApp } from './app';
import { automationDepsFromEnv, handleCron, handleQueueBatch } from './automation/orchestrator';
import type { Env } from './env';

const app = createApp();

export default {
  fetch: app.fetch,
  /** Consumidor de la cola de trabajos y de su DLQ. */
  queue: (batch, env) => handleQueueBatch(automationDepsFromEnv(env), batch),
  /** Cron Triggers (UTC): Scheduler y Recovery Worker. */
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(handleCron(automationDepsFromEnv(env), controller.cron));
  },
} satisfies ExportedHandler<Env>;

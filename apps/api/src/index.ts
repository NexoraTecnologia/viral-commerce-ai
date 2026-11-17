import { createApp } from './app';
import type { Env } from './env';
import { handleQueueBatch } from './queue-consumer';

const app = createApp();

export default {
  fetch: app.fetch,
  queue: handleQueueBatch,
} satisfies ExportedHandler<Env>;

import { dispatchMessage, type HandlerMap } from '@vc/queue';
import type { Env } from './env';

const handlers: HandlerMap = {
  'system.ping': (message) => {
    console.info('system.ping recibido', { id: message.id });
    return Promise.resolve();
  },
};

/** Consumidor de Cloudflare Queues: valida cada mensaje y decide ack / retry. */
export const handleQueueBatch = async (batch: MessageBatch, _env: Env): Promise<void> => {
  for (const message of batch.messages) {
    try {
      const outcome = await dispatchMessage(message.body, handlers);
      if (outcome.status === 'invalid') {
        console.warn('Mensaje inválido descartado', { id: message.id, issues: outcome.issues });
      }
      message.ack();
    } catch (error) {
      console.error('Fallo procesando mensaje, se reintentará', {
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
      message.retry();
    }
  }
};

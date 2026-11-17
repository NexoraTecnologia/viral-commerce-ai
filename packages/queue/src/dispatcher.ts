import { newId, nowIso } from '@vc/shared';
import { parseQueueMessage, type QueueMessage, type QueueMessageType } from './messages';

export type MessageHandler<M extends QueueMessage> = (message: M) => Promise<void>;

export type HandlerMap = {
  [T in QueueMessageType]: MessageHandler<Extract<QueueMessage, { type: T }>>;
};

export type DispatchOutcome =
  | { readonly status: 'handled'; readonly type: QueueMessageType }
  | { readonly status: 'invalid'; readonly issues: string };

/**
 * Valida y despacha un mensaje crudo al handler correspondiente.
 * Los mensajes inválidos NO se reintentan (se reportan como "invalid").
 */
export const dispatchMessage = async (
  raw: unknown,
  handlers: HandlerMap,
): Promise<DispatchOutcome> => {
  const parsed = parseQueueMessage(raw);
  if (!parsed.success) {
    return { status: 'invalid', issues: parsed.error.message };
  }
  const message = parsed.data;
  // HandlerMap garantiza un handler por tipo; TS no correlaciona uniones mapeadas.
  const handler = handlers[message.type] as MessageHandler<QueueMessage>;
  await handler(message);
  return { status: 'handled', type: message.type };
};

/** Crea un mensaje con sobre completo listo para `queue.send()`. */
export const createMessage = <T extends QueueMessageType>(
  type: T,
  payload: Extract<QueueMessage, { type: T }>['payload'],
): Extract<QueueMessage, { type: T }> =>
  ({ type, schemaVersion: 1, id: newId(), createdAt: nowIso(), payload }) as Extract<
    QueueMessage,
    { type: T }
  >;

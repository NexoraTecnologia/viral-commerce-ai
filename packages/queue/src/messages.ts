import { z } from 'zod';

/**
 * Mensajes de Cloudflare Queues. Cada mensaje es una unión discriminada por
 * `type` y lleva versión de esquema para poder evolucionar sin romper consumidores.
 */
const envelope = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({
    type: z.literal(type),
    schemaVersion: z.literal(1),
    id: z.uuid(),
    createdAt: z.iso.datetime(),
    payload,
  });

export const SystemPingMessageSchema = envelope(
  'system.ping',
  z.object({ note: z.string().max(200).optional() }),
);

export const QueueMessageSchema = z.discriminatedUnion('type', [SystemPingMessageSchema]);
export type QueueMessage = z.infer<typeof QueueMessageSchema>;
export type QueueMessageType = QueueMessage['type'];

export const parseQueueMessage = (raw: unknown) => QueueMessageSchema.safeParse(raw);

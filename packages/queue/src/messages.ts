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

/**
 * Puntero a un trabajo persistido en D1. La cola NO es la fuente de verdad:
 * si el mensaje se pierde (p. ej. por la retención del plan gratuito), el
 * Recovery Worker lo vuelve a despachar desde D1.
 */
export const JobExecuteMessageSchema = envelope(
  'job.execute',
  z.object({
    jobId: z.uuid(),
    tenantId: z.uuid(),
    /** Menor = más urgente. Se usa para ordenar dentro de cada lote. */
    priority: z.number().int().min(0).max(100),
  }),
);

export const QueueMessageSchema = z.discriminatedUnion('type', [
  SystemPingMessageSchema,
  JobExecuteMessageSchema,
]);
export type QueueMessage = z.infer<typeof QueueMessageSchema>;
export type QueueMessageType = QueueMessage['type'];

export const parseQueueMessage = (raw: unknown) => QueueMessageSchema.safeParse(raw);

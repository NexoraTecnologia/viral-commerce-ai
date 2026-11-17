import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { missingRequiredEvidence } from '@vc/business-rules';
import { channelConnections, suppliers } from '@vc/database';
import { PermanentJobError, PRIORITY } from '@vc/queue';
import { listSupplierProducts } from '../modules/catalog/service';
import { autoPublishReady, checkConnection } from '../modules/channels/service';
import { processWebhookEvent } from '../modules/channels/webhooks';
import { reevaluateBlocked, scanSupplierTimeouts } from '../modules/orders/service';
import { rescoreActive, syncSource } from '../modules/discovery/service';
import { calculateForProduct } from '../modules/profit/service';
import { listEvidence, toEvidenceFacts } from '../modules/suppliers/service';
import { defineHandler, registryOf, type JobHandlerContext } from './types';

/**
 * Tipos de trabajo ("agentes") registrados. Todos son internos: leen D1 y
 * calculan; NINGUNO compra, publica, cobra ni contacta a terceros.
 * Para agregar un agente: definir aquí su handler; su frecuencia se configura
 * en D1 desde el dashboard (no se crea un Cron Trigger nuevo).
 */

const HOUR_MS = 3_600_000;

export const systemPing = defineHandler({
  type: 'system.ping',
  category: 'SYSTEM',
  description: 'Verifica que la cadena Scheduler → Cola → Consumidor funcione.',
  defaultPriority: PRIORITY.LOW,
  defaultMaxAttempts: 3,
  defaultTimeoutSeconds: 10,
  payloadSchema: z.object({ note: z.string().max(200).optional() }),
  run: (ctx, payload) =>
    Promise.resolve({ pong: true, at: ctx.now.toISOString(), note: payload.note ?? null }),
});

export const inventoryStaleScan = defineHandler({
  type: 'inventory.stale_scan',
  category: 'MAINTENANCE',
  description: 'Detecta ofertas con stock desconocido, agotado o con control vencido.',
  defaultPriority: PRIORITY.NORMAL,
  defaultMaxAttempts: 3,
  defaultTimeoutSeconds: 60,
  payloadSchema: z.object({}),
  run: async (ctx) => {
    const offers = await listSupplierProducts(ctx.db, ctx.tenantId, {});
    const maxAgeMs = ctx.config.MAX_STOCK_AGE_HOURS * HOUR_MS;
    const unknown: string[] = [];
    const stale: string[] = [];
    const outOfStock: string[] = [];
    for (const o of offers) {
      const inv = o.latestInventory;
      if (!inv || inv.stockStatus === 'UNKNOWN') unknown.push(o.id);
      else {
        if (inv.stockStatus === 'OUT_OF_STOCK') outOfStock.push(o.id);
        if (ctx.now.getTime() - new Date(inv.checkedAt).getTime() > maxAgeMs) stale.push(o.id);
      }
    }
    const result = {
      scanned: offers.length,
      unknown: unknown.length,
      stale: stale.length,
      outOfStock: outOfStock.length,
      offerIds: {
        unknown: unknown.slice(0, 50),
        stale: stale.slice(0, 50),
        outOfStock: outOfStock.slice(0, 50),
      },
    };
    await ctx.audit.log({
      tenantId: ctx.tenantId,
      action: 'inventory.stale_scan',
      metadata: { scanned: result.scanned, unknown: result.unknown, stale: result.stale },
    });
    return result;
  },
});

export const supplierEvidenceExpiryScan = defineHandler({
  type: 'supplier.evidence_expiry_scan',
  category: 'MAINTENANCE',
  description:
    'Lista proveedores verificados cuya evidencia obligatoria venció (no cambia estados: decide una persona).',
  defaultPriority: PRIORITY.NORMAL,
  defaultMaxAttempts: 3,
  defaultTimeoutSeconds: 60,
  payloadSchema: z.object({}),
  run: async (ctx) => {
    const verified = await ctx.db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, ctx.tenantId), eq(suppliers.status, 'VERIFIED')))
      .limit(500);
    const affected: { supplierId: string; missing: string[] }[] = [];
    for (const s of verified) {
      const missing = missingRequiredEvidence(
        toEvidenceFacts(await listEvidence(ctx.db, ctx.tenantId, s.id)),
        ctx.now,
      );
      if (missing.length > 0) affected.push({ supplierId: s.id, missing });
    }
    if (affected.length > 0) {
      await ctx.audit.log({
        tenantId: ctx.tenantId,
        action: 'supplier.evidence_expired',
        metadata: { count: affected.length },
      });
    }
    return { scanned: verified.length, affected };
  },
});

/** Evento comercial (prioridad máxima): recalcular rentabilidad de un producto. */
export const profitRecalculateProduct = defineHandler({
  type: 'profit.recalculate_product',
  category: 'COMMERCIAL',
  description: 'Recalcula y registra la rentabilidad de un producto con una oferta.',
  defaultPriority: PRIORITY.COMMERCIAL,
  defaultMaxAttempts: 5,
  defaultTimeoutSeconds: 30,
  payloadSchema: z.object({ productId: z.uuid(), supplierProductId: z.uuid() }),
  run: async (ctx, payload) => {
    const r = await calculateForProduct(
      ctx.db,
      ctx.tenantId,
      payload.productId,
      payload.supplierProductId,
      ctx.config,
      ctx.now,
    );
    if (!r.ok) {
      // Producto u oferta inexistente / no vinculada: reintentar no lo arregla.
      throw new PermanentJobError(r.error.message);
    }
    return { calculationId: r.value.id, status: r.value.status, issues: r.value.issues };
  },
});

/** Re-analiza productos en investigación y candidatos con los datos más recientes. */
export const discoveryRescore = defineHandler({
  type: 'discovery.rescore',
  category: 'MAINTENANCE',
  description: 'Recalcula puntaje, señales de mercado y Risk Guardian de productos activos.',
  defaultPriority: PRIORITY.NORMAL,
  defaultMaxAttempts: 3,
  defaultTimeoutSeconds: 120,
  payloadSchema: z.object({}),
  run: (ctx) => rescoreActive(ctx.db, ctx.tenantId, ctx.config, ctx.now),
});

/** Sincroniza una fuente. Si no está conectada, termina informando NOT_CONFIGURED. */
export const discoverySourceSync = defineHandler({
  type: 'discovery.source_sync',
  category: 'MAINTENANCE',
  description: 'Sincroniza una fuente de investigación mediante su adaptador.',
  defaultPriority: PRIORITY.LOW,
  defaultMaxAttempts: 3,
  defaultTimeoutSeconds: 120,
  payloadSchema: z.object({ sourceId: z.uuid() }),
  run: async (ctx, payload) => {
    const r = await syncSource(ctx.db, ctx.tenantId, payload.sourceId, ctx.now);
    if (!r.ok) throw new PermanentJobError(r.error.message);
    return r.value;
  },
});

const runtimeOf = (ctx: JobHandlerContext) => ({
  db: ctx.db,
  tenantId: ctx.tenantId,
  config: ctx.config,
  secrets: ctx.secrets,
  now: ctx.now,
});

/** Procesa un webhook guardado (consulta el recurso real en el canal). */
export const channelsWebhookProcess = defineHandler({
  type: 'channels.webhook_process',
  category: 'COMMERCIAL',
  description: 'Procesa un webhook recibido de un canal (pedidos, mensajes, estados).',
  defaultPriority: PRIORITY.COMMERCIAL,
  defaultMaxAttempts: 5,
  defaultTimeoutSeconds: 30,
  payloadSchema: z.object({ eventId: z.uuid() }),
  run: async (ctx, payload) => {
    const r = await processWebhookEvent(runtimeOf(ctx), payload.eventId);
    if (!r.ok) {
      if (r.error.code === 'NOT_FOUND') throw new PermanentJobError(r.error.message);
      throw new Error(r.error.message);
    }
    return r.value;
  },
});

/** Verifica conexiones LIVE y renueva tokens vencidos cuando el canal lo soporta. */
export const channelsConnectionCheck = defineHandler({
  type: 'channels.connection_check',
  category: 'MAINTENANCE',
  description: 'Verifica el estado real de las conexiones y renueva tokens si corresponde.',
  defaultPriority: PRIORITY.NORMAL,
  defaultMaxAttempts: 3,
  defaultTimeoutSeconds: 120,
  payloadSchema: z.object({}),
  run: async (ctx) => {
    const rows = await ctx.db
      .select({ id: channelConnections.id, status: channelConnections.status })
      .from(channelConnections)
      .where(
        and(eq(channelConnections.tenantId, ctx.tenantId), eq(channelConnections.mode, 'LIVE')),
      );
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (row.status === 'DISABLED') continue;
      const r = await checkConnection(runtimeOf(ctx), row.id);
      result[row.id] = r.ok ? r.value.status : r.error.code;
    }
    return { checked: Object.keys(result).length, result };
  },
});

/**
 * Publicación automática: intenta publicar las publicaciones READY. Cada una pasa
 * por el gate completo; con COMMERCIAL_ACTIONS_ENABLED=false ninguna sale en LIVE.
 */
export const channelsAutoPublish = defineHandler({
  type: 'channels.auto_publish',
  category: 'COMMERCIAL',
  description: 'Publica automáticamente solo si se cumplen todas las condiciones.',
  defaultPriority: PRIORITY.NORMAL,
  defaultMaxAttempts: 1,
  defaultTimeoutSeconds: 120,
  payloadSchema: z.object({}),
  run: (ctx) => autoPublishReady(runtimeOf(ctx)),
});

const orderRuntimeOf = (ctx: JobHandlerContext) => ({
  db: ctx.db,
  tenantId: ctx.tenantId,
  config: ctx.config,
  now: ctx.now,
});

/** Solicitudes al proveedor vencidas sin respuesta → bloqueo y búsqueda de alternativa. */
export const ordersSupplierTimeoutScan = defineHandler({
  type: 'orders.supplier_timeout_scan',
  category: 'COMMERCIAL',
  description: 'Marca sin respuesta a los proveedores que no confirmaron en el plazo.',
  defaultPriority: PRIORITY.COMMERCIAL,
  defaultMaxAttempts: 3,
  defaultTimeoutSeconds: 60,
  payloadSchema: z.object({}),
  run: (ctx) => scanSupplierTimeouts(orderRuntimeOf(ctx)),
});

/** Reevalúa pedidos bloqueados (stock, proveedor, fondos) y envíos sin entrega confirmada. */
export const ordersReevaluate = defineHandler({
  type: 'orders.reevaluate',
  category: 'COMMERCIAL',
  description: 'Reevalúa pedidos bloqueados y envíos vencidos con los datos más recientes.',
  defaultPriority: PRIORITY.NORMAL,
  defaultMaxAttempts: 3,
  defaultTimeoutSeconds: 120,
  payloadSchema: z.object({}),
  run: (ctx) => reevaluateBlocked(orderRuntimeOf(ctx)),
});

export const defaultHandlers = registryOf([
  systemPing,
  inventoryStaleScan,
  supplierEvidenceExpiryScan,
  profitRecalculateProduct,
  discoveryRescore,
  discoverySourceSync,
  channelsWebhookProcess,
  channelsConnectionCheck,
  channelsAutoPublish,
  ordersSupplierTimeoutScan,
  ordersReevaluate,
]);

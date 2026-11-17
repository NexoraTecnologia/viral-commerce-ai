import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { missingRequiredEvidence } from '@vc/business-rules';
import { suppliers } from '@vc/database';
import { PermanentJobError, PRIORITY } from '@vc/queue';
import { listSupplierProducts } from '../modules/catalog/service';
import { rescoreActive, syncSource } from '../modules/discovery/service';
import { calculateForProduct } from '../modules/profit/service';
import { listEvidence, toEvidenceFacts } from '../modules/suppliers/service';
import { defineHandler, registryOf } from './types';

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

export const defaultHandlers = registryOf([
  systemPing,
  inventoryStaleScan,
  supplierEvidenceExpiryScan,
  profitRecalculateProduct,
  discoveryRescore,
  discoverySourceSync,
]);

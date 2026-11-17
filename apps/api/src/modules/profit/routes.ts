import { Hono } from 'hono';
import { calculateProfit, evaluateFinancialGuard } from '@vc/business-rules';
import { auditEvents } from '@vc/database';
import {
  CreateProfitCalculationRequestSchema,
  FinancialGuardRequestSchema,
  IdParamSchema,
  newId,
  ProfitSimulationRequestSchema,
} from '@vc/shared';
import type { AppBindings } from '../../env';
import { fail, idParam, readJson, respond } from '../../http';
import { calculateForProduct, listCalculations } from './service';

export const profitRoutes = new Hono<AppBindings>()
  /** Calcula y registra la rentabilidad de un producto con una oferta. */
  .post('/products/:id/profit-calculations', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, CreateProfitCalculationRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await calculateForProduct(
        c.var.db,
        c.var.tenantId,
        id.value,
        body.value.supplierProductId,
        c.var.config,
        new Date(),
      ),
      201,
    );
  })

  .get('/profit-calculations', async (c) => {
    const productId = c.req.query('productId');
    if (productId !== undefined && !IdParamSchema.safeParse(productId).success) {
      return c.json({ items: [] });
    }
    return c.json({ items: await listCalculations(c.var.db, c.var.tenantId, productId) });
  })

  /** Simulación pura: no lee ni escribe la base de datos. */
  .post('/profit/simulate', async (c) => {
    const body = await readJson(c, ProfitSimulationRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      calculateProfit({
        ...body.value,
        minMarginBps: body.value.minMarginBps ?? c.var.config.MIN_NET_MARGIN_BPS,
      }),
    );
  })

  /** Financial Guard: evalúa una operación con datos financieros reales provistos. */
  .post('/financial-guard/evaluate', async (c) => {
    const body = await readJson(c, FinancialGuardRequestSchema);
    if (!body.ok) return fail(c, body.error);
    const now = new Date();
    const result = evaluateFinancialGuard(
      body.value,
      {
        maxFundsDataAgeHours: c.var.config.MAX_FUNDS_DATA_AGE_HOURS,
        maxReturnRiskBps: c.var.config.MAX_RETURN_RISK_BPS,
      },
      now,
    );
    await c.var.db.insert(auditEvents).values({
      id: newId(),
      tenantId: c.var.tenantId,
      action: 'financial_guard.evaluated',
      entityType: 'operation',
      metadata: { decision: result.decision, issues: result.issues },
      dryRun: true,
      createdAt: now,
    });
    return c.json(result);
  });

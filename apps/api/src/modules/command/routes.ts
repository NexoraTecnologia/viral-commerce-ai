import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { CreateRuleChangeRequestSchema, UpdateSettingsRequestSchema } from '@vc/shared';
import { secretsFromEnv, type AppBindings } from '../../env';
import { fail, idParam, readJson, respond } from '../../http';
import * as svc from './service';

const rtOf = (c: Context<AppBindings>): svc.CommandRuntime => ({
  db: c.var.db,
  tenantId: c.var.tenantId,
  config: c.var.config,
  now: new Date(),
});

const AuditQuerySchema = z.object({
  source: z.enum(['SYSTEM', 'ORDER']).default('SYSTEM'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
  q: z.string().trim().max(80).optional(),
});

/** Command Center: lecturas agregadas para el dashboard (sin efectos). */
export const commandRoutes = new Hono<AppBindings>()
  .get('/overview', async (c) => c.json(await svc.overview(rtOf(c))))
  .get('/shipments', async (c) => c.json({ items: await svc.listShipments(rtOf(c)) }))
  .get('/customers', async (c) => c.json({ items: await svc.listCustomers(rtOf(c)) }))
  .get('/audit', async (c) => {
    const q = AuditQuerySchema.safeParse(c.req.query());
    if (!q.success)
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Parámetros inválidos' } }, 400);
    return c.json(await svc.listAudit(rtOf(c), q.data));
  })
  .get('/rules', (c) => c.json({ items: svc.listRules(rtOf(c)) }))
  .get('/rules/change-requests', async (c) =>
    c.json({ items: await svc.listRuleRequests(rtOf(c)) }),
  )
  .post('/rules/change-requests', async (c) => {
    const body = await readJson(c, CreateRuleChangeRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await svc.proposeRuleChange(rtOf(c), body.value), 201);
  })
  .post('/rules/change-requests/:id/withdraw', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.withdrawRuleRequest(rtOf(c), id.value));
  })
  .get('/settings', async (c) => respond(c, await svc.getSettings(rtOf(c), secretsFromEnv(c.env))))
  .patch('/settings', async (c) => {
    const body = await readJson(c, UpdateSettingsRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await svc.updateSettings(rtOf(c), secretsFromEnv(c.env), body.value.name));
  });

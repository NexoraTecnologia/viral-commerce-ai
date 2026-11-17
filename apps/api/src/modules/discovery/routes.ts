import { Hono } from 'hono';
import { z } from 'zod';
import {
  appError,
  CreateCategoryRequestSchema,
  CreateCompetitorRequestSchema,
  CreateDiscoveredProductRequestSchema,
  CreateSourceRequestSchema,
  DiscardRequestSchema,
  DiscoveryStatusSchema,
  RecordAttributeRequestSchema,
  RecordDemandObservationRequestSchema,
  RecordImageRequestSchema,
  RecordPriceObservationRequestSchema,
  UpdateDiscoveredProductRequestSchema,
} from '@vc/shared';
import type { AppBindings } from '../../env';
import { fail, idParam, readJson, respond } from '../../http';
import {
  analyzeDiscovered,
  classifyDiscovered,
  createCategory,
  createCompetitor,
  createDiscovered,
  createSource,
  generateForDiscovered,
  getDiscoveredDetail,
  listCategories,
  listCompetitors,
  listContents,
  listDiscovered,
  listSources,
  promoteDiscovered,
  radar,
  recordAttribute,
  recordDemand,
  recordImage,
  recordPrice,
  setDiscoveryStatus,
  setSourceEnabled,
  syncSource,
  updateDiscovered,
} from './service';

export const discoveryRoutes = new Hono<AppBindings>()
  /* ---- Fuentes ---- */
  .get('/sources', async (c) => c.json({ items: await listSources(c.var.db, c.var.tenantId) }))
  .post('/sources', async (c) => {
    const body = await readJson(c, CreateSourceRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return c.json(await createSource(c.var.db, c.var.tenantId, body.value, new Date()), 201);
  })
  .patch('/sources/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, z.object({ enabled: z.boolean() }));
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await setSourceEnabled(c.var.db, c.var.tenantId, id.value, body.value.enabled, new Date()),
    );
  })
  .post('/sources/:id/sync', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await syncSource(c.var.db, c.var.tenantId, id.value, new Date()));
  })

  /* ---- Categorías y competidores ---- */
  .get('/categories', async (c) =>
    c.json({ items: await listCategories(c.var.db, c.var.tenantId) }),
  )
  .post('/categories', async (c) => {
    const body = await readJson(c, CreateCategoryRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await createCategory(c.var.db, c.var.tenantId, body.value, new Date()), 201);
  })
  .get('/competitors', async (c) =>
    c.json({ items: await listCompetitors(c.var.db, c.var.tenantId) }),
  )
  .post('/competitors', async (c) => {
    const body = await readJson(c, CreateCompetitorRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return c.json(await createCompetitor(c.var.db, c.var.tenantId, body.value, new Date()), 201);
  })

  /* ---- Radar y productos detectados ---- */
  .get('/radar', async (c) => c.json({ items: await radar(c.var.db, c.var.tenantId) }))
  .get('/products', async (c) => {
    const raw = c.req.query('status');
    const status = raw === undefined ? undefined : DiscoveryStatusSchema.safeParse(raw);
    if (status && !status.success) return fail(c, appError('VALIDATION_ERROR', 'Estado inválido'));
    return c.json({
      items: await listDiscovered(c.var.db, c.var.tenantId, { status: status?.data }),
    });
  })
  .post('/products', async (c) => {
    const body = await readJson(c, CreateDiscoveredProductRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await createDiscovered(c.var.db, c.var.tenantId, body.value, new Date()),
      201,
    );
  })
  .get('/products/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await getDiscoveredDetail(c.var.db, c.var.tenantId, id.value));
  })
  .patch('/products/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, UpdateDiscoveredProductRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await updateDiscovered(c.var.db, c.var.tenantId, id.value, body.value, new Date()),
    );
  })
  .post('/products/:id/classify', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await classifyDiscovered(c.var.db, c.var.tenantId, id.value, new Date()));
  })
  .post('/products/:id/demand', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, RecordDemandObservationRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await recordDemand(c.var.db, c.var.tenantId, id.value, body.value, new Date()),
      201,
    );
  })
  .post('/products/:id/prices', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, RecordPriceObservationRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await recordPrice(c.var.db, c.var.tenantId, id.value, body.value, new Date()),
      201,
    );
  })
  .post('/products/:id/attributes', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, RecordAttributeRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await recordAttribute(c.var.db, c.var.tenantId, id.value, body.value, new Date()),
      201,
    );
  })
  .post('/products/:id/images', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, RecordImageRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await recordImage(c.var.db, c.var.tenantId, id.value, body.value, new Date()),
      201,
    );
  })
  .post('/products/:id/analyze', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(
      c,
      await analyzeDiscovered(c.var.db, c.var.tenantId, id.value, c.var.config, new Date()),
      201,
    );
  })
  .post('/products/:id/promote', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(
      c,
      await promoteDiscovered(c.var.db, c.var.tenantId, id.value, c.var.config, new Date()),
    );
  })
  .post('/products/:id/discard', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, DiscardRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await setDiscoveryStatus(
        c.var.db,
        c.var.tenantId,
        id.value,
        'DISCARDED',
        body.value.reason,
        new Date(),
      ),
    );
  })
  .post('/products/:id/reopen', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(
      c,
      await setDiscoveryStatus(c.var.db, c.var.tenantId, id.value, 'RESEARCHING', null, new Date()),
    );
  })

  /* ---- Contenido ---- */
  .post('/products/:id/content', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(
      c,
      await generateForDiscovered(c.var.db, c.var.tenantId, id.value, new Date()),
      201,
    );
  })
  .get('/content', async (c) => {
    const productId = c.req.query('productId');
    if (productId !== undefined && !z.uuid().safeParse(productId).success)
      return c.json({ items: [] });
    return c.json({ items: await listContents(c.var.db, c.var.tenantId, productId) });
  });

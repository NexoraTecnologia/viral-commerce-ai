import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createDb } from '@vc/database';
import { notConfiguredCheckout } from '@vc/integrations';
import {
  ConnectWithTokenRequestSchema,
  CreateAffiliateLinkRequestSchema,
  CreateAffiliateNetworkRequestSchema,
  CreateAffiliateProductRequestSchema,
  CreateConnectionRequestSchema,
  newId,
  parseApiConfig,
  PrepareListingRequestSchema,
  PrepareMessageRequestSchema,
  RecordConversionRequestSchema,
  UpdateConversionStatusRequestSchema,
} from '@vc/shared';
import { createJob } from '../../automation/job-manager';
import { defaultHandlers } from '../../automation/handlers';
import { systemClock } from '../../automation/types';
import { secretsFromEnv, type AppBindings } from '../../env';
import { fail, idParam, readJson, respond } from '../../http';
import * as aff from './affiliates';
import type { ChannelRuntime } from './runtime';
import * as svc from './service';
import { findTenantBySlug, renderProductPage, storeCatalog, toStoreProduct } from './store';
import { receiveWebhook, webhookChannelOf } from './webhooks';

const rtOf = (c: Context<AppBindings>): ChannelRuntime => ({
  db: c.var.db,
  tenantId: c.var.tenantId,
  config: c.var.config,
  secrets: secretsFromEnv(c.env),
  now: new Date(),
});

const enabledBody = z.object({ enabled: z.boolean() });

/* =============================== /v1/channels =============================== */

export const channelRoutes = new Hono<AppBindings>()
  .get('/connections', async (c) => c.json({ items: await svc.listConnections(rtOf(c)) }))
  .post('/connections', async (c) => {
    const body = await readJson(c, CreateConnectionRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await svc.createConnection(rtOf(c), body.value), 201);
  })
  .post('/connections/:id/oauth/start', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.startOAuth(rtOf(c), id.value));
  })
  .post('/connections/:id/token', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, ConnectWithTokenRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await svc.connectWithToken(rtOf(c), id.value, body.value));
  })
  .post('/connections/:id/check', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.checkConnection(rtOf(c), id.value));
  })
  .post('/connections/:id/refresh', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.refreshConnection(rtOf(c), id.value));
  })
  .post('/connections/:id/disconnect', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.disconnectConnection(rtOf(c), id.value));
  })
  .patch('/connections/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, enabledBody);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await svc.setConnectionEnabled(rtOf(c), id.value, body.value.enabled));
  })
  .get('/connections/:id/catalog', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const r = await svc.getCatalog(rtOf(c), id.value);
    return r.ok ? c.json({ items: r.value }) : fail(c, r.error);
  })
  .post('/connections/:id/orders/sync', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.syncOrders(rtOf(c), id.value));
  })
  .post('/connections/:id/questions/sync', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.syncQuestions(rtOf(c), id.value));
  })
  .get('/connections/:id/orders/:externalId', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const ext = c.req.param('externalId');
    if (!/^[\w-]{1,64}$/.test(ext))
      return c.json({ error: { code: 'NOT_FOUND', message: 'Pedido inexistente' } }, 404);
    return respond(c, await svc.refreshOrderStatus(rtOf(c), id.value, ext));
  })

  .get('/listings', async (c) => c.json({ items: await svc.listListings(rtOf(c)) }))
  .post('/listings', async (c) => {
    const body = await readJson(c, PrepareListingRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await svc.prepareListing(rtOf(c), body.value), 201);
  })
  .get('/listings/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.getListing(rtOf(c), id.value));
  })
  .get('/listings/:id/preview', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const r = await svc.getListing(rtOf(c), id.value);
    if (!r.ok) return fail(c, r.error);
    return c.html(
      renderProductPage(toStoreProduct(r.value.id, r.value.draft, true), 'Vista previa'),
    );
  })
  .post('/listings/:id/publish', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.publishListing(rtOf(c), id.value, 'MANUAL'));
  })
  .post('/listings/:id/sync', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.syncListing(rtOf(c), id.value));
  })
  .post('/listings/:id/pause', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.pauseListing(rtOf(c), id.value));
  })

  .get('/orders', async (c) => c.json({ items: await svc.listOrders(rtOf(c)) }))
  .get('/messages', async (c) => c.json({ items: await svc.listMessages(rtOf(c)) }))
  .post('/messages', async (c) => {
    const body = await readJson(c, PrepareMessageRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await svc.prepareMessage(rtOf(c), body.value), 201);
  })
  .post('/messages/:id/send', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    return respond(c, await svc.sendMessage(rtOf(c), id.value));
  })
  .get('/logs', async (c) => c.json({ items: await svc.listLogs(rtOf(c)) }))
  .get('/webhook-events', async (c) => c.json({ items: await svc.listWebhookEvents(rtOf(c)) }));

/* ============================== /v1/affiliates ============================== */

export const affiliateRoutes = new Hono<AppBindings>()
  .get('/networks', async (c) =>
    c.json({ items: await aff.listNetworks(c.var.db, c.var.tenantId) }),
  )
  .post('/networks', async (c) => {
    const body = await readJson(c, CreateAffiliateNetworkRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await aff.createNetwork(c.var.db, c.var.tenantId, body.value, new Date()),
      201,
    );
  })
  .patch('/networks/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, enabledBody);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await aff.setNetworkEnabled(
        c.var.db,
        c.var.tenantId,
        id.value,
        body.value.enabled,
        new Date(),
      ),
    );
  })
  .get('/products', async (c) =>
    c.json({ items: await aff.listAffiliateProducts(c.var.db, c.var.tenantId) }),
  )
  .post('/products', async (c) => {
    const body = await readJson(c, CreateAffiliateProductRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await aff.createAffiliateProduct(c.var.db, c.var.tenantId, body.value, new Date()),
      201,
    );
  })
  .get('/links', async (c) => c.json({ items: await aff.listLinks(c.var.db, c.var.tenantId) }))
  .post('/links', async (c) => {
    const body = await readJson(c, CreateAffiliateLinkRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(c, await aff.createLink(c.var.db, c.var.tenantId, body.value, new Date()), 201);
  })
  .patch('/links/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, z.object({ active: z.boolean() }));
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await aff.setLinkActive(c.var.db, c.var.tenantId, id.value, body.value.active, new Date()),
    );
  })
  .get('/conversions', async (c) =>
    c.json({ items: await aff.listConversions(c.var.db, c.var.tenantId) }),
  )
  .post('/conversions', async (c) => {
    const body = await readJson(c, RecordConversionRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await aff.recordConversion(c.var.db, c.var.tenantId, body.value, new Date()),
      201,
    );
  })
  .patch('/conversions/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, UpdateConversionStatusRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await aff.setConversionStatus(
        c.var.db,
        c.var.tenantId,
        id.value,
        body.value.status,
        new Date(),
      ),
    );
  })
  .get('/summary', async (c) => c.json(await aff.affiliateSummary(c.var.db, c.var.tenantId)));

/* ================================ Rutas públicas ================================ */

const publicBase = (c: Context<AppBindings>) => ({
  db: createDb(c.env.DB),
  config: parseApiConfig({ ...c.env }),
  secrets: secretsFromEnv(c.env),
  now: new Date(),
});

export const publicChannelRoutes = new Hono<AppBindings>()
  /** Webhooks de canales. Responden rápido; el procesamiento va a la cola. */
  .on(['GET', 'POST'], '/webhooks/:channel', async (c) => {
    const channel = webhookChannelOf(c.req.param('channel'));
    if (!channel)
      return c.json({ error: { code: 'NOT_FOUND', message: 'Canal inexistente' } }, 404);
    const base = publicBase(c);
    const rawBody = c.req.method === 'POST' ? await c.req.text() : '';
    if (rawBody.length > 3_000_000)
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Payload demasiado grande' } },
        413,
      );
    const result = await receiveWebhook(base, channel, {
      method: c.req.method === 'GET' ? 'GET' : 'POST',
      rawBody,
      headers: c.req.header(),
      query: c.req.query(),
    });
    if (result.kind === 'challenge') return c.text(result.body, 200);
    if (result.kind === 'rejected') {
      console.warn('webhook rechazado', { channel, reason: result.reason });
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Webhook rechazado' } }, 401);
    }
    for (const event of result.routed) {
      await createJob(
        {
          db: base.db,
          queue: c.env.JOBS_QUEUE,
          clock: systemClock,
          handlers: defaultHandlers,
          config: base.config,
          workerId: `webhook:${newId()}`,
          secrets: base.secrets,
        },
        event.tenantId,
        {
          type: 'channels.webhook_process',
          payload: { eventId: event.id },
          idempotencyKey: `webhook:${event.id}`,
        },
      );
    }
    return c.json({ received: result.stored, duplicates: result.duplicates });
  })

  /** Callback OAuth (Mercado Libre / Instagram). */
  .get('/oauth/callback/:channel', async (c) => {
    const slug = c.req.param('channel') as keyof typeof svc.OAUTH_CHANNELS;
    const channel = svc.OAUTH_CHANNELS[slug] as
      (typeof svc.OAUTH_CHANNELS)[keyof typeof svc.OAUTH_CHANNELS] | undefined;
    const state = c.req.query('state');
    const code = c.req.query('code');
    if (!channel || !state || !code) return c.text('Solicitud OAuth inválida', 400);
    const r = await svc.completeOAuth(publicBase(c), channel, state, code);
    return r.ok
      ? c.html(
          '<!doctype html><meta charset="utf-8"><p>Conexión verificada. Ya podés cerrar esta ventana.</p>',
        )
      : c.html(
          `<!doctype html><meta charset="utf-8"><p>No se pudo conectar: ${r.error.code}</p>`,
          400,
        );
  })

  /** Tienda propia: catálogo y páginas de producto. */
  .get('/store/:slug/products', async (c) => {
    const base = publicBase(c);
    const tenant = await findTenantBySlug(base.db, c.req.param('slug'));
    if (!tenant)
      return c.json({ error: { code: 'NOT_FOUND', message: 'Tienda inexistente' } }, 404);
    return c.json({ items: await storeCatalog(base.db, tenant.id) });
  })
  .get('/store/:slug/p/:listingId', async (c) => {
    const base = publicBase(c);
    const tenant = await findTenantBySlug(base.db, c.req.param('slug'));
    if (!tenant) return c.text('Tienda inexistente', 404);
    const product = (await storeCatalog(base.db, tenant.id)).find(
      (p) => p.listingId === c.req.param('listingId'),
    );
    if (!product) return c.text('Producto no disponible', 404);
    return c.html(renderProductPage(product, tenant.name));
  })
  /** Checkout separado: sin pasarela configurada responde 503. No se simulan pagos. */
  .post('/store/:slug/checkout', async (c) => {
    const r = await notConfiguredCheckout.createSession({
      listingId: '',
      amountCents: 0,
      currency: 'ARS',
      idempotencyKey: newId(),
    });
    return respond(c, r);
  })

  /** Redirección de afiliados: registra el clic y va SOLO al destino registrado. */
  .get('/r/:code', async (c) => {
    const code = c.req.param('code');
    if (!/^[\w-]{6,32}$/.test(code)) return c.text('Enlace inexistente', 404);
    const db = createDb(c.env.DB);
    const destination = await aff.trackClick(
      db,
      code,
      { referrer: c.req.header('referer'), country: c.req.header('cf-ipcountry') },
      new Date(),
    );
    return destination ? c.redirect(destination, 302) : c.text('Enlace inexistente', 404);
  });

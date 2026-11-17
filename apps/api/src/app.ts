import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { isOriginAllowed, parseAllowedOrigins } from '@vc/security';
import { API_VERSION, parseApiConfig, type ErrorResponse, type HealthResponse } from '@vc/shared';
import type { AppBindings } from './env';
import { requireTenant } from './middleware/tenant';
import { automationRoutes } from './modules/automation/routes';
import { commandRoutes } from './modules/command/routes';
import { fundsRoutes, orderRoutes, supportRoutes } from './modules/orders/routes';
import { affiliateRoutes, channelRoutes, publicChannelRoutes } from './modules/channels/routes';
import { discoveryRoutes } from './modules/discovery/routes';
import { productRoutes, supplierProductRoutes } from './modules/catalog/routes';
import { profitRoutes } from './modules/profit/routes';
import { supplierRoutes } from './modules/suppliers/routes';
import { tenantRoutes } from './modules/tenants/routes';

export const createApp = () => {
  const app = new Hono<AppBindings>();

  app.use('*', secureHeaders());

  app.use(
    '*',
    cors({
      origin: (origin, c) =>
        isOriginAllowed(
          origin,
          parseAllowedOrigins((c.env as AppBindings['Bindings']).ALLOWED_ORIGINS),
        )
          ? origin
          : null,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowHeaders: ['Content-Type', 'X-Tenant-Id'],
      maxAge: 600,
    }),
  );

  app.get('/health', (c) => {
    const config = parseApiConfig({ ...c.env });
    const body: HealthResponse = {
      status: 'ok',
      service: 'viralcommerce-api',
      version: API_VERSION,
      environment: config.APP_ENV,
      commercialActionsEnabled: config.COMMERCIAL_ACTIONS_ENABLED,
      timestamp: new Date().toISOString(),
    };
    return c.json(body);
  });

  app.route('/v1/tenants', tenantRoutes);
  // Rutas públicas: webhooks (firma/app validada), callback OAuth, tienda y /r/:code.
  app.route('/', publicChannelRoutes);

  const v1 = new Hono<AppBindings>();
  v1.use('*', requireTenant);
  v1.route('/suppliers', supplierRoutes);
  v1.route('/supplier-products', supplierProductRoutes);
  v1.route('/products', productRoutes);
  v1.route('/automation', automationRoutes);
  v1.route('/discovery', discoveryRoutes);
  v1.route('/channels', channelRoutes);
  v1.route('/affiliates', affiliateRoutes);
  v1.route('/orders', orderRoutes);
  v1.route('/support', supportRoutes);
  v1.route('/finance/funds', fundsRoutes);
  v1.route('/command', commandRoutes);
  v1.route('/', profitRoutes);
  app.route('/v1', v1);

  app.notFound((c) =>
    c.json<ErrorResponse>({ error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' } }, 404),
  );

  app.onError((error, c) => {
    // No exponer detalles internos al cliente.
    console.error('Unhandled error', { message: error.message, path: c.req.path });
    return c.json<ErrorResponse>(
      { error: { code: 'INTERNAL_ERROR', message: 'Error interno' } },
      500,
    );
  });

  return app;
};

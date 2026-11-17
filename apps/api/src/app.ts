import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { isOriginAllowed, parseAllowedOrigins } from '@vc/security';
import { API_VERSION, parseApiConfig, type ErrorResponse, type HealthResponse } from '@vc/shared';
import type { AppBindings } from './env';

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

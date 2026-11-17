import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { createDb, tenants } from '@vc/database';
import { appError, IdParamSchema, parseApiConfig } from '@vc/shared';
import type { AppBindings } from '../env';
import { fail } from '../http';

/**
 * Contexto de tenant TEMPORAL (Fase 2 lo reemplaza por autenticación real).
 * Solo funciona con APP_ENV=development: en staging/production responde 401,
 * así un despliegue accidental no expone datos con un header adivinable.
 */
export const requireTenant: MiddlewareHandler<AppBindings> = async (c, next) => {
  const config = parseApiConfig({ ...c.env });
  if (config.APP_ENV !== 'development') {
    return fail(c, appError('UNAUTHORIZED', 'Autenticación aún no implementada'));
  }
  const parsed = IdParamSchema.safeParse(c.req.header('x-tenant-id'));
  if (!parsed.success) {
    return fail(c, appError('UNAUTHORIZED', 'Falta o es inválido el header X-Tenant-Id'));
  }
  const db = createDb(c.env.DB);
  const tenant = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, parsed.data))
    .get();
  if (!tenant) return fail(c, appError('UNAUTHORIZED', 'Tenant inexistente'));

  c.set('tenantId', tenant.id);
  c.set('db', db);
  c.set('config', config);
  return next();
};

/** Para rutas sin tenant (alta de tenants en desarrollo). */
export const devOnly: MiddlewareHandler<AppBindings> = async (c, next) => {
  const config = parseApiConfig({ ...c.env });
  if (config.APP_ENV !== 'development') {
    return fail(c, appError('FORBIDDEN', 'Disponible solo en desarrollo'));
  }
  c.set('db', createDb(c.env.DB));
  c.set('config', config);
  return next();
};

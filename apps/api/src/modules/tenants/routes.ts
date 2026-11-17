import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { tenants } from '@vc/database';
import { appError, CreateTenantRequestSchema, newId, type TenantDto } from '@vc/shared';
import type { AppBindings } from '../../env';
import { devOnly } from '../../middleware/tenant';
import { fail, iso, readJson } from '../../http';

const toDto = (t: typeof tenants.$inferSelect): TenantDto => ({
  id: t.id,
  name: t.name,
  slug: t.slug,
  createdAt: iso(t.createdAt),
});

/** Alta de espacios de trabajo — solo desarrollo, hasta tener autenticación. */
export const tenantRoutes = new Hono<AppBindings>()
  .use('*', devOnly)
  .get('/', async (c) => {
    const rows = await c.var.db.select().from(tenants).orderBy(desc(tenants.createdAt)).limit(50);
    return c.json({ items: rows.map(toDto) });
  })
  .post('/', async (c) => {
    const body = await readJson(c, CreateTenantRequestSchema);
    if (!body.ok) return fail(c, body.error);
    const db = c.var.db;
    const existing = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, body.value.slug))
      .get();
    if (existing) return fail(c, appError('CONFLICT', 'El slug ya existe'));
    const row = await db
      .insert(tenants)
      .values({ id: newId(), ...body.value })
      .returning()
      .get();
    return c.json(toDto(row), 201);
  });

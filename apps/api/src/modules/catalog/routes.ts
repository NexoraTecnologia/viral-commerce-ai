import { Hono } from 'hono';
import {
  CostComponentSchema,
  CreateProductRequestSchema,
  CreateSupplierProductRequestSchema,
  IdParamSchema,
  LinkSupplierProductRequestSchema,
  RecordInventoryRequestSchema,
  UpdateProductRequestSchema,
  UpdateSupplierPriceRequestSchema,
} from '@vc/shared';
import type { AppBindings } from '../../env';
import { fail, idParam, notFound, readJson, respond } from '../../http';
import {
  addProductCost,
  createProduct,
  createSupplierProduct,
  deleteProductCost,
  findProduct,
  linkSupplierProduct,
  listInventoryHistory,
  listProductCosts,
  listProducts,
  listSupplierProducts,
  recordInventory,
  toProductDto,
  updateProduct,
  updateSupplierPrice,
} from './service';

export const productRoutes = new Hono<AppBindings>()
  .get('/', async (c) => c.json({ items: await listProducts(c.var.db, c.var.tenantId) }))

  .post('/', async (c) => {
    const body = await readJson(c, CreateProductRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return c.json(await createProduct(c.var.db, c.var.tenantId, body.value, new Date()), 201);
  })

  .get('/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const row = await findProduct(c.var.db, c.var.tenantId, id.value);
    return row ? c.json(toProductDto(row)) : fail(c, notFound('Producto').error);
  })

  .patch('/:id', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, UpdateProductRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await updateProduct(c.var.db, c.var.tenantId, id.value, body.value, new Date()),
    );
  })

  .get('/:id/costs', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const r = await listProductCosts(c.var.db, c.var.tenantId, id.value);
    return r.ok ? c.json({ items: r.value }) : fail(c, r.error);
  })

  .post('/:id/costs', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, CostComponentSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await addProductCost(c.var.db, c.var.tenantId, id.value, body.value, new Date()),
      201,
    );
  })

  .delete('/:id/costs/:costId', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const costId = idParam(c, 'costId');
    if (!costId.ok) return fail(c, costId.error);
    return respond(c, await deleteProductCost(c.var.db, c.var.tenantId, id.value, costId.value));
  });

export const supplierProductRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    const productId = c.req.query('productId');
    if (productId !== undefined && !IdParamSchema.safeParse(productId).success) {
      return c.json({ items: [] });
    }
    return c.json({ items: await listSupplierProducts(c.var.db, c.var.tenantId, { productId }) });
  })

  .post('/', async (c) => {
    const body = await readJson(c, CreateSupplierProductRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await createSupplierProduct(c.var.db, c.var.tenantId, body.value, new Date()),
      201,
    );
  })

  .patch('/:id/price', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, UpdateSupplierPriceRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await updateSupplierPrice(c.var.db, c.var.tenantId, id.value, body.value, new Date()),
    );
  })

  .patch('/:id/link', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, LinkSupplierProductRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await linkSupplierProduct(
        c.var.db,
        c.var.tenantId,
        id.value,
        body.value.productId,
        new Date(),
      ),
    );
  })

  .get('/:id/inventory', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const r = await listInventoryHistory(c.var.db, c.var.tenantId, id.value);
    return r.ok ? c.json({ items: r.value }) : fail(c, r.error);
  })

  .post('/:id/inventory', async (c) => {
    const id = idParam(c, 'id');
    if (!id.ok) return fail(c, id.error);
    const body = await readJson(c, RecordInventoryRequestSchema);
    if (!body.ok) return fail(c, body.error);
    return respond(
      c,
      await recordInventory(c.var.db, c.var.tenantId, id.value, body.value, new Date()),
      201,
    );
  });

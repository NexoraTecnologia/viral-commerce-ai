import { and, desc, eq, sql } from 'drizzle-orm';
import {
  productCosts,
  products,
  supplierInventory,
  supplierProducts,
  suppliers,
  type Database,
  type ProductCostRow,
  type ProductRow,
  type SupplierInventoryRow,
} from '@vc/database';
import {
  appError,
  err,
  newId,
  ok,
  type CostComponent,
  type CreateProductRequest,
  type CreateSupplierProductRequest,
  type InventorySnapshotDto,
  type ProductCostDto,
  type ProductDto,
  type RecordInventoryRequest,
  type Result,
  type SupplierProductDto,
  type UpdateProductRequest,
  type UpdateSupplierPriceRequest,
} from '@vc/shared';
import { iso, notFound } from '../../http';
import { findSupplier } from '../suppliers/service';

/* ---------- Mapeos ---------- */

export const toProductDto = (p: ProductRow): ProductDto => ({
  id: p.id,
  title: p.title,
  description: p.description,
  category: p.category,
  salePriceCents: p.salePriceCents,
  currency: p.currency,
  status: p.status,
  createdAt: iso(p.createdAt),
  updatedAt: iso(p.updatedAt),
});

const toInventoryDto = (i: SupplierInventoryRow): InventorySnapshotDto => ({
  id: i.id,
  stockStatus: i.stockStatus,
  quantity: i.quantity,
  checkedAt: iso(i.checkedAt),
  source: i.source,
});

const toCostDto = (c: ProductCostRow): ProductCostDto => ({
  id: c.id,
  productId: c.productId,
  kind: c.kind,
  name: c.name,
  fixedCents: c.fixedCents,
  rateBps: c.rateBps,
  createdAt: iso(c.createdAt),
});

export const toCostComponent = (c: ProductCostRow): CostComponent => ({
  kind: c.kind,
  name: c.name,
  ...(c.fixedCents === null ? {} : { fixedCents: c.fixedCents }),
  ...(c.rateBps === null ? {} : { rateBps: c.rateBps }),
});

/* ---------- Productos ---------- */

export const findProduct = (db: Database, tenantId: string, id: string) =>
  db
    .select()
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.id, id)))
    .get();

export const listProducts = async (db: Database, tenantId: string) =>
  (
    await db
      .select()
      .from(products)
      .where(eq(products.tenantId, tenantId))
      .orderBy(desc(products.updatedAt))
      .limit(500)
  ).map(toProductDto);

export const createProduct = async (
  db: Database,
  tenantId: string,
  input: CreateProductRequest,
  now: Date,
): Promise<ProductDto> =>
  toProductDto(
    await db
      .insert(products)
      .values({
        id: newId(),
        tenantId,
        title: input.title,
        description: input.description ?? null,
        category: input.category ?? null,
        salePriceCents: input.salePriceCents,
        currency: input.currency,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get(),
  );

export const updateProduct = async (
  db: Database,
  tenantId: string,
  id: string,
  input: UpdateProductRequest,
  now: Date,
): Promise<Result<ProductDto>> => {
  if (!(await findProduct(db, tenantId, id))) return notFound('Producto');
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const row = await db
    .update(products)
    .set({ ...patch, updatedAt: now })
    .where(eq(products.id, id))
    .returning()
    .get();
  return ok(toProductDto(row));
};

export const listProductCostRows = (db: Database, tenantId: string, productId: string) =>
  db
    .select()
    .from(productCosts)
    .where(and(eq(productCosts.tenantId, tenantId), eq(productCosts.productId, productId)))
    .orderBy(productCosts.createdAt)
    .all();

export const listProductCosts = async (
  db: Database,
  tenantId: string,
  productId: string,
): Promise<Result<ProductCostDto[]>> => {
  if (!(await findProduct(db, tenantId, productId))) return notFound('Producto');
  return ok((await listProductCostRows(db, tenantId, productId)).map(toCostDto));
};

export const addProductCost = async (
  db: Database,
  tenantId: string,
  productId: string,
  input: CostComponent,
  now: Date,
): Promise<Result<ProductCostDto>> => {
  if (!(await findProduct(db, tenantId, productId))) return notFound('Producto');
  const row = await db
    .insert(productCosts)
    .values({
      id: newId(),
      tenantId,
      productId,
      kind: input.kind,
      name: input.name,
      fixedCents: input.fixedCents ?? null,
      rateBps: input.rateBps ?? null,
      createdAt: now,
    })
    .returning()
    .get();
  return ok(toCostDto(row));
};

export const deleteProductCost = async (
  db: Database,
  tenantId: string,
  productId: string,
  costId: string,
): Promise<Result<{ deleted: true }>> => {
  const deleted = await db
    .delete(productCosts)
    .where(
      and(
        eq(productCosts.tenantId, tenantId),
        eq(productCosts.productId, productId),
        eq(productCosts.id, costId),
      ),
    )
    .returning({ id: productCosts.id });
  return deleted.length > 0 ? ok({ deleted: true }) : notFound('Costo');
};

/* ---------- Catálogo del proveedor ---------- */

export const findSupplierProduct = (db: Database, tenantId: string, id: string) =>
  db
    .select()
    .from(supplierProducts)
    .where(and(eq(supplierProducts.tenantId, tenantId), eq(supplierProducts.id, id)))
    .get();

/** Último control de stock por oferta (subconsulta por máximo `checked_at`). */
const latestInventoryByOffer = async (
  db: Database,
  tenantId: string,
): Promise<Map<string, SupplierInventoryRow>> => {
  const rows = await db
    .select()
    .from(supplierInventory)
    .where(
      and(
        eq(supplierInventory.tenantId, tenantId),
        sql`${supplierInventory.checkedAt} = (select max(si2.checked_at) from supplier_inventory si2 where si2.supplier_product_id = ${supplierInventory.supplierProductId})`,
      ),
    )
    .orderBy(desc(supplierInventory.createdAt))
    .all();
  const map = new Map<string, SupplierInventoryRow>();
  for (const r of rows) if (!map.has(r.supplierProductId)) map.set(r.supplierProductId, r);
  return map;
};

export const getLatestInventory = async (
  db: Database,
  tenantId: string,
  supplierProductId: string,
): Promise<SupplierInventoryRow | null> =>
  (await db
    .select()
    .from(supplierInventory)
    .where(
      and(
        eq(supplierInventory.tenantId, tenantId),
        eq(supplierInventory.supplierProductId, supplierProductId),
      ),
    )
    .orderBy(desc(supplierInventory.checkedAt), desc(supplierInventory.createdAt))
    .get()) ?? null;

export const listSupplierProducts = async (
  db: Database,
  tenantId: string,
  filter: { productId?: string | undefined; id?: string | undefined },
): Promise<SupplierProductDto[]> => {
  const rows = await db
    .select({
      offer: supplierProducts,
      supplierName: suppliers.legalName,
      supplierStatus: suppliers.status,
    })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .where(
      and(
        eq(supplierProducts.tenantId, tenantId),
        filter.productId ? eq(supplierProducts.productId, filter.productId) : undefined,
        filter.id ? eq(supplierProducts.id, filter.id) : undefined,
      ),
    )
    .orderBy(desc(supplierProducts.updatedAt))
    .limit(500);
  const inventory = await latestInventoryByOffer(db, tenantId);
  return rows.map(({ offer, supplierName, supplierStatus }) => {
    const inv = inventory.get(offer.id);
    return {
      id: offer.id,
      supplierId: offer.supplierId,
      supplierName,
      supplierStatus,
      productId: offer.productId,
      supplierSku: offer.supplierSku,
      title: offer.title,
      wholesalePriceCents: offer.wholesalePriceCents,
      currency: offer.currency,
      priceUpdatedAt: iso(offer.priceUpdatedAt),
      priceSource: offer.priceSource,
      minOrderQty: offer.minOrderQty,
      latestInventory: inv ? toInventoryDto(inv) : null,
    };
  });
};

const getSupplierProductDto = async (db: Database, tenantId: string, id: string) => {
  const [item] = await listSupplierProducts(db, tenantId, { id });
  return item ? ok(item) : notFound('Oferta');
};

export const createSupplierProduct = async (
  db: Database,
  tenantId: string,
  input: CreateSupplierProductRequest,
  now: Date,
): Promise<Result<SupplierProductDto>> => {
  if (!(await findSupplier(db, tenantId, input.supplierId))) return notFound('Proveedor');
  if (input.productId && !(await findProduct(db, tenantId, input.productId))) {
    return notFound('Producto');
  }
  const duplicate = await db
    .select({ id: supplierProducts.id })
    .from(supplierProducts)
    .where(
      and(
        eq(supplierProducts.supplierId, input.supplierId),
        eq(supplierProducts.supplierSku, input.supplierSku),
      ),
    )
    .get();
  if (duplicate) return err(appError('CONFLICT', 'El SKU ya existe para este proveedor'));

  const priceUpdatedAt = input.priceUpdatedAt ? new Date(input.priceUpdatedAt) : now;
  if (priceUpdatedAt.getTime() > now.getTime()) {
    return err(appError('VALIDATION_ERROR', 'La fecha del precio no puede ser futura'));
  }
  const id = newId();
  await db.insert(supplierProducts).values({
    id,
    tenantId,
    supplierId: input.supplierId,
    productId: input.productId ?? null,
    supplierSku: input.supplierSku,
    title: input.title,
    wholesalePriceCents: input.wholesalePriceCents,
    currency: input.currency,
    priceUpdatedAt,
    priceSource: input.priceSource,
    minOrderQty: input.minOrderQty,
    createdAt: now,
    updatedAt: now,
  });
  return getSupplierProductDto(db, tenantId, id);
};

export const updateSupplierPrice = async (
  db: Database,
  tenantId: string,
  id: string,
  input: UpdateSupplierPriceRequest,
  now: Date,
): Promise<Result<SupplierProductDto>> => {
  if (!(await findSupplierProduct(db, tenantId, id))) return notFound('Oferta');
  const priceUpdatedAt = input.priceUpdatedAt ? new Date(input.priceUpdatedAt) : now;
  if (priceUpdatedAt.getTime() > now.getTime()) {
    return err(appError('VALIDATION_ERROR', 'La fecha del precio no puede ser futura'));
  }
  await db
    .update(supplierProducts)
    .set({
      wholesalePriceCents: input.wholesalePriceCents,
      priceUpdatedAt,
      priceSource: input.priceSource,
      updatedAt: now,
    })
    .where(eq(supplierProducts.id, id));
  return getSupplierProductDto(db, tenantId, id);
};

export const linkSupplierProduct = async (
  db: Database,
  tenantId: string,
  id: string,
  productId: string | null,
  now: Date,
): Promise<Result<SupplierProductDto>> => {
  if (!(await findSupplierProduct(db, tenantId, id))) return notFound('Oferta');
  if (productId && !(await findProduct(db, tenantId, productId))) return notFound('Producto');
  await db
    .update(supplierProducts)
    .set({ productId, updatedAt: now })
    .where(eq(supplierProducts.id, id));
  return getSupplierProductDto(db, tenantId, id);
};

export const recordInventory = async (
  db: Database,
  tenantId: string,
  supplierProductId: string,
  input: RecordInventoryRequest,
  now: Date,
): Promise<Result<InventorySnapshotDto>> => {
  if (!(await findSupplierProduct(db, tenantId, supplierProductId))) return notFound('Oferta');
  const checkedAt = input.checkedAt ? new Date(input.checkedAt) : now;
  if (checkedAt.getTime() > now.getTime()) {
    return err(appError('VALIDATION_ERROR', 'La fecha del control no puede ser futura'));
  }
  const row = await db
    .insert(supplierInventory)
    .values({
      id: newId(),
      tenantId,
      supplierProductId,
      stockStatus: input.stockStatus,
      quantity: input.quantity ?? null,
      checkedAt,
      source: input.source,
      createdAt: now,
    })
    .returning()
    .get();
  return ok(toInventoryDto(row));
};

export const listInventoryHistory = async (
  db: Database,
  tenantId: string,
  supplierProductId: string,
): Promise<Result<InventorySnapshotDto[]>> => {
  if (!(await findSupplierProduct(db, tenantId, supplierProductId))) return notFound('Oferta');
  const rows = await db
    .select()
    .from(supplierInventory)
    .where(
      and(
        eq(supplierInventory.tenantId, tenantId),
        eq(supplierInventory.supplierProductId, supplierProductId),
      ),
    )
    .orderBy(desc(supplierInventory.checkedAt))
    .limit(100);
  return ok(rows.map(toInventoryDto));
};

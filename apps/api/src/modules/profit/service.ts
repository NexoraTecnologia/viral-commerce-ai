import { and, desc, eq } from 'drizzle-orm';
import { evaluateViability } from '@vc/business-rules';
import {
  products,
  profitCalculations,
  type Database,
  type ProfitCalculationRow,
} from '@vc/database';
import {
  appError,
  err,
  newId,
  ok,
  type ApiConfig,
  type ProfitCalculationDto,
  type Result,
} from '@vc/shared';
import { iso, notFound } from '../../http';
import {
  findProduct,
  findSupplierProduct,
  getLatestInventory,
  listProductCostRows,
  toCostComponent,
} from '../catalog/service';
import { findSupplier, listEvidence, toEvidenceFacts } from '../suppliers/service';

const toDto = (row: ProfitCalculationRow, productTitle: string): ProfitCalculationDto => ({
  id: row.id,
  productId: row.productId,
  productTitle,
  supplierProductId: row.supplierProductId,
  currency: row.currency,
  status: row.status,
  issues: row.issues,
  breakdown: row.breakdown ?? null,
  calculatedAt: iso(row.calculatedAt),
});

/**
 * Evalúa la viabilidad SIN persistir (lo usa Risk Guardian). Misma fuente de
 * datos y reglas que `calculateForProduct`.
 */
export const evaluateForProduct = async (
  db: Database,
  tenantId: string,
  productId: string,
  supplierProductId: string,
  config: ApiConfig,
  now: Date,
) => {
  const product = await findProduct(db, tenantId, productId);
  if (!product) return notFound('Producto');
  const offer = await findSupplierProduct(db, tenantId, supplierProductId);
  if (!offer) return notFound('Oferta');
  if (offer.productId !== productId) {
    return err(appError('CONFLICT', 'La oferta del proveedor no está vinculada a este producto'));
  }
  const supplier = await findSupplier(db, tenantId, offer.supplierId);
  if (!supplier) return notFound('Proveedor');
  const [evidence, inventory, costRows] = await Promise.all([
    listEvidence(db, tenantId, supplier.id),
    getLatestInventory(db, tenantId, offer.id),
    listProductCostRows(db, tenantId, productId),
  ]);
  const result = evaluateViability({
    supplier,
    evidence: toEvidenceFacts(evidence),
    offer,
    inventory,
    product,
    components: costRows.map(toCostComponent),
    policy: {
      minMarginBps: config.MIN_NET_MARGIN_BPS,
      maxPriceAgeHours: config.MAX_PRICE_AGE_HOURS,
      maxStockAgeHours: config.MAX_STOCK_AGE_HOURS,
    },
    now,
  });
  if (!result.ok) return result;
  return ok({ viability: result.value, product, offer, supplier, inventory });
};

/**
 * Calcula y GUARDA la rentabilidad de un producto con una oferta concreta,
 * usando exclusivamente datos registrados (proveedor, evidencia, precio, stock,
 * costos). No hay valores por defecto inventados: lo que falta bloquea.
 */
export const calculateForProduct = async (
  db: Database,
  tenantId: string,
  productId: string,
  supplierProductId: string,
  config: ApiConfig,
  now: Date,
): Promise<Result<ProfitCalculationDto>> => {
  const product = await findProduct(db, tenantId, productId);
  if (!product) return notFound('Producto');
  const offer = await findSupplierProduct(db, tenantId, supplierProductId);
  if (!offer) return notFound('Oferta');
  if (offer.productId !== productId) {
    return err(appError('CONFLICT', 'La oferta del proveedor no está vinculada a este producto'));
  }
  const supplier = await findSupplier(db, tenantId, offer.supplierId);
  if (!supplier) return notFound('Proveedor');

  const [evidence, inventory, costRows] = await Promise.all([
    listEvidence(db, tenantId, supplier.id),
    getLatestInventory(db, tenantId, offer.id),
    listProductCostRows(db, tenantId, productId),
  ]);
  const components = costRows.map(toCostComponent);
  const policy = {
    minMarginBps: config.MIN_NET_MARGIN_BPS,
    maxPriceAgeHours: config.MAX_PRICE_AGE_HOURS,
    maxStockAgeHours: config.MAX_STOCK_AGE_HOURS,
  };

  const result = evaluateViability({
    supplier,
    evidence: toEvidenceFacts(evidence),
    offer,
    inventory,
    product,
    components,
    policy,
    now,
  });
  if (!result.ok) return result;
  const { status, issues, breakdown } = result.value;

  const row = await db
    .insert(profitCalculations)
    .values({
      id: newId(),
      tenantId,
      productId,
      supplierProductId,
      currency: product.currency,
      status,
      issues: [...issues],
      salePriceCents: product.salePriceCents,
      totalCostsCents: breakdown?.totalCostsCents ?? null,
      netProfitCents: breakdown?.netProfitCents ?? null,
      marginBps: breakdown?.marginBps ?? null,
      minMarginBps: policy.minMarginBps,
      breakdown,
      inputSnapshot: {
        supplier: { id: supplier.id, status: supplier.status },
        offer: {
          wholesalePriceCents: offer.wholesalePriceCents,
          currency: offer.currency,
          priceUpdatedAt: iso(offer.priceUpdatedAt),
          priceSource: offer.priceSource,
        },
        inventory: inventory
          ? { stockStatus: inventory.stockStatus, checkedAt: iso(inventory.checkedAt) }
          : null,
        components,
        policy,
      },
      calculatedAt: now,
    })
    .returning()
    .get();
  return ok(toDto(row, product.title));
};

export const listCalculations = async (
  db: Database,
  tenantId: string,
  productId?: string,
): Promise<ProfitCalculationDto[]> => {
  const rows = await db
    .select({ calc: profitCalculations, productTitle: products.title })
    .from(profitCalculations)
    .innerJoin(products, eq(products.id, profitCalculations.productId))
    .where(
      and(
        eq(profitCalculations.tenantId, tenantId),
        productId ? eq(profitCalculations.productId, productId) : undefined,
      ),
    )
    .orderBy(desc(profitCalculations.calculatedAt))
    .limit(200);
  return rows.map(({ calc, productTitle }) => toDto(calc, productTitle));
};

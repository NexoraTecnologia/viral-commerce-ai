import { and, desc, eq, inArray, isNotNull, max } from 'drizzle-orm';
import {
  assessRisk,
  computeProductScore,
  CONTENT_TEMPLATE_VERSION,
  detectOpportunity,
  detectSaturation,
  detectTrend,
  generateContent,
  suggestCategory,
  summarizePrices,
  type ContentFacts,
} from '@vc/business-rules';
import {
  auditEvents,
  competitors,
  demandObservations,
  discoveredProducts,
  discoveryAnalyses,
  generatedContents,
  priceObservations,
  productAttributes,
  productCategories,
  productImages,
  researchSources,
  supplierProducts,
  suppliers,
  type Database,
  type DiscoveredProductRow,
  type DiscoveryAnalysisRow,
  type GeneratedContentRow,
  type ResearchSourceRow,
} from '@vc/database';
import {
  createDiscoveryAdapters,
  type DiscoveryAdapter,
  type DiscoverySignal,
} from '@vc/integrations';
import {
  appError,
  err,
  newId,
  ok,
  type AnalysisDto,
  type ApiConfig,
  type CategoryDto,
  type CompetitorDto,
  type CreateCategoryRequest,
  type CreateCompetitorRequest,
  type CreateDiscoveredProductRequest,
  type CreateSourceRequest,
  type DiscoveredProductDetailDto,
  type DiscoveredProductDto,
  type DiscoveryStatus,
  type GeneratedContentDto,
  type ObservationDto,
  type RecordAttributeRequest,
  type RecordDemandObservationRequest,
  type RecordImageRequest,
  type RecordPriceObservationRequest,
  type Result,
  type SourceDto,
  type SourceSyncResult,
  type UpdateDiscoveredProductRequest,
} from '@vc/shared';
import { iso, isoOrNull, notFound } from '../../http';
import { findProduct, findSupplierProduct, getLatestInventory } from '../catalog/service';
import { evaluateForProduct } from '../profit/service';

/* ======================= Adaptadores ======================= */

/** Catálogos de proveedores: datos propios en D1 (ofertas cargadas), siempre disponible. */
const supplierCatalogAdapter = (db: Database): DiscoveryAdapter => ({
  kind: 'SUPPLIER_CATALOG',
  status: () => ({
    status: 'CONFIGURED',
    detail: 'Lee las ofertas de proveedores registradas en el sistema',
  }),
  fetchSignals: async ({ tenantId }) => {
    const linked = await db
      .select({ id: discoveredProducts.supplierProductId })
      .from(discoveredProducts)
      .where(
        and(
          eq(discoveredProducts.tenantId, tenantId),
          isNotNull(discoveredProducts.supplierProductId),
        ),
      );
    const known = new Set(linked.map((l) => l.id));
    const offers = await db
      .select()
      .from(supplierProducts)
      .where(eq(supplierProducts.tenantId, tenantId))
      .limit(500);
    return ok(
      offers
        .filter((o) => !known.has(o.id))
        .map((o): DiscoverySignal => ({
          title: o.title,
          sourceRef: `supplier-sku:${o.supplierSku}`,
          observedAt: o.priceUpdatedAt,
          supplierProductId: o.id,
        })),
    );
  },
});

export const discoveryAdapters = (db: Database) =>
  createDiscoveryAdapters({ SUPPLIER_CATALOG: supplierCatalogAdapter(db) });

/* ======================= Fuentes ======================= */

const toSourceDto = (s: ResearchSourceRow, adapter: DiscoveryAdapter): SourceDto => {
  const a = adapter.status();
  const status = !s.enabled
    ? 'DISABLED'
    : a.status === 'CONFIGURED' && s.lastError
      ? 'ERROR'
      : a.status;
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    status,
    statusDetail: status === 'ERROR' ? s.lastError : a.detail,
    reference: s.reference,
    usageAuthorization: s.usageAuthorization,
    enabled: s.enabled,
    lastSyncAt: isoOrNull(s.lastSyncAt),
    lastError: s.lastError,
    createdAt: iso(s.createdAt),
  };
};

const findSource = (db: Database, tenantId: string, id: string) =>
  db
    .select()
    .from(researchSources)
    .where(and(eq(researchSources.tenantId, tenantId), eq(researchSources.id, id)))
    .get();

export const listSources = async (db: Database, tenantId: string): Promise<SourceDto[]> => {
  const adapters = discoveryAdapters(db);
  const rows = await db
    .select()
    .from(researchSources)
    .where(eq(researchSources.tenantId, tenantId))
    .orderBy(researchSources.name);
  return rows.map((r) => toSourceDto(r, adapters[r.kind]));
};

export const createSource = async (
  db: Database,
  tenantId: string,
  input: CreateSourceRequest,
  now: Date,
): Promise<SourceDto> => {
  const row = await db
    .insert(researchSources)
    .values({
      id: newId(),
      tenantId,
      name: input.name,
      kind: input.kind,
      reference: input.reference ?? null,
      usageAuthorization: input.usageAuthorization ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toSourceDto(row, discoveryAdapters(db)[row.kind]);
};

export const setSourceEnabled = async (
  db: Database,
  tenantId: string,
  id: string,
  enabled: boolean,
  now: Date,
): Promise<Result<SourceDto>> => {
  if (!(await findSource(db, tenantId, id))) return notFound('Fuente');
  const row = await db
    .update(researchSources)
    .set({ enabled, updatedAt: now })
    .where(eq(researchSources.id, id))
    .returning()
    .get();
  return ok(toSourceDto(row, discoveryAdapters(db)[row.kind]));
};

/** Sincroniza una fuente vía su adaptador. Si no está conectada, informa NOT_CONFIGURED. */
export const syncSource = async (
  db: Database,
  tenantId: string,
  id: string,
  now: Date,
): Promise<Result<SourceSyncResult>> => {
  const source = await findSource(db, tenantId, id);
  if (!source) return notFound('Fuente');
  if (!source.enabled) return err(appError('CONFLICT', 'La fuente está deshabilitada'));
  const adapter = discoveryAdapters(db)[source.kind];
  const status = adapter.status();
  if (status.status !== 'CONFIGURED') {
    return ok({ sourceId: id, status: status.status, message: status.detail, created: 0 });
  }
  const signals = await adapter.fetchSignals({ tenantId });
  if (!signals.ok) {
    const notConfigured = signals.error.code === 'INTEGRATION_NOT_CONFIGURED';
    if (!notConfigured && source.kind !== 'MANUAL') {
      await db
        .update(researchSources)
        .set({ lastError: signals.error.message, updatedAt: now })
        .where(eq(researchSources.id, id));
    }
    return ok({
      sourceId: id,
      status: notConfigured ? 'NOT_CONFIGURED' : source.kind === 'MANUAL' ? 'CONFIGURED' : 'ERROR',
      message: signals.error.message,
      created: 0,
    });
  }
  const categories = await listCategoryRows(db, tenantId);
  let created = 0;
  for (const s of signals.value) {
    const offer = s.supplierProductId
      ? await findSupplierProduct(db, tenantId, s.supplierProductId)
      : undefined;
    const category = suggestCategory(s.title, categories);
    await db.insert(discoveredProducts).values({
      id: newId(),
      tenantId,
      title: s.title,
      sourceId: id,
      sourceRef: s.sourceRef,
      observedAt: s.observedAt,
      supplierProductId: offer?.id ?? null,
      productId: offer?.productId ?? null,
      categoryId: category?.id ?? null,
      categorySource: category ? 'RULE' : null,
      createdAt: now,
      updatedAt: now,
    });
    created++;
  }
  await db
    .update(researchSources)
    .set({ lastSyncAt: now, lastError: null, updatedAt: now })
    .where(eq(researchSources.id, id));
  return ok({
    sourceId: id,
    status: 'CONFIGURED',
    message: `${created} productos detectados`,
    created,
  });
};

/* ======================= Categorías y competidores ======================= */

const listCategoryRows = (db: Database, tenantId: string) =>
  db
    .select()
    .from(productCategories)
    .where(eq(productCategories.tenantId, tenantId))
    .orderBy(productCategories.name);

export const listCategories = async (db: Database, tenantId: string): Promise<CategoryDto[]> =>
  (await listCategoryRows(db, tenantId)).map((c) => ({
    id: c.id,
    name: c.name,
    keywords: c.keywords,
  }));

export const createCategory = async (
  db: Database,
  tenantId: string,
  input: CreateCategoryRequest,
  now: Date,
): Promise<Result<CategoryDto>> => {
  const dup = await db
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(and(eq(productCategories.tenantId, tenantId), eq(productCategories.name, input.name)))
    .get();
  if (dup) return err(appError('CONFLICT', 'La categoría ya existe'));
  const row = await db
    .insert(productCategories)
    .values({
      id: newId(),
      tenantId,
      name: input.name,
      keywords: input.keywords,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return ok({ id: row.id, name: row.name, keywords: row.keywords });
};

export const listCompetitors = async (db: Database, tenantId: string): Promise<CompetitorDto[]> =>
  (
    await db
      .select()
      .from(competitors)
      .where(eq(competitors.tenantId, tenantId))
      .orderBy(competitors.name)
  ).map((c) => ({ id: c.id, name: c.name, channel: c.channel, url: c.url, notes: c.notes }));

export const createCompetitor = async (
  db: Database,
  tenantId: string,
  input: CreateCompetitorRequest,
  now: Date,
): Promise<CompetitorDto> => {
  const c = await db
    .insert(competitors)
    .values({
      id: newId(),
      tenantId,
      name: input.name,
      channel: input.channel,
      url: input.url ?? null,
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return { id: c.id, name: c.name, channel: c.channel, url: c.url, notes: c.notes };
};

/* ======================= Productos detectados ======================= */

const findDiscovered = (db: Database, tenantId: string, id: string) =>
  db
    .select()
    .from(discoveredProducts)
    .where(and(eq(discoveredProducts.tenantId, tenantId), eq(discoveredProducts.id, id)))
    .get();

const latestAnalyses = async (db: Database, tenantId: string, ids: readonly string[]) => {
  const map = new Map<string, DiscoveryAnalysisRow>();
  if (ids.length === 0) return map;
  const latest = db
    .select({
      id: discoveryAnalyses.discoveredProductId,
      at: max(discoveryAnalyses.analyzedAt).as('at'),
    })
    .from(discoveryAnalyses)
    .where(eq(discoveryAnalyses.tenantId, tenantId))
    .groupBy(discoveryAnalyses.discoveredProductId)
    .as('latest');
  const rows = await db
    .select({ a: discoveryAnalyses })
    .from(discoveryAnalyses)
    .innerJoin(
      latest,
      and(
        eq(latest.id, discoveryAnalyses.discoveredProductId),
        eq(latest.at, discoveryAnalyses.analyzedAt),
      ),
    );
  for (const { a } of rows) if (!map.has(a.discoveredProductId)) map.set(a.discoveredProductId, a);
  return map;
};

const toDiscoveredDto = (
  p: DiscoveredProductRow,
  sourceName: string,
  categoryName: string | null,
  a: DiscoveryAnalysisRow | undefined,
): DiscoveredProductDto => ({
  id: p.id,
  title: p.title,
  status: p.status,
  discardReason: p.discardReason,
  categoryId: p.categoryId,
  categoryName,
  categorySource: p.categorySource,
  sourceId: p.sourceId,
  sourceName,
  sourceRef: p.sourceRef,
  observedAt: iso(p.observedAt),
  productId: p.productId,
  supplierProductId: p.supplierProductId,
  latestScore: a?.score ?? null,
  latestConfidence: a?.confidence ?? null,
  opportunity: a?.opportunity ?? null,
  saturated: a?.saturated ?? null,
  riskPassed: a?.riskPassed ?? null,
  analyzedAt: a ? iso(a.analyzedAt) : null,
  createdAt: iso(p.createdAt),
});

export const listDiscovered = async (
  db: Database,
  tenantId: string,
  filter: { status?: DiscoveryStatus | undefined; id?: string | undefined } = {},
): Promise<DiscoveredProductDto[]> => {
  const rows = await db
    .select({
      p: discoveredProducts,
      sourceName: researchSources.name,
      categoryName: productCategories.name,
    })
    .from(discoveredProducts)
    .innerJoin(researchSources, eq(researchSources.id, discoveredProducts.sourceId))
    .leftJoin(productCategories, eq(productCategories.id, discoveredProducts.categoryId))
    .where(
      and(
        eq(discoveredProducts.tenantId, tenantId),
        filter.status ? eq(discoveredProducts.status, filter.status) : undefined,
        filter.id ? eq(discoveredProducts.id, filter.id) : undefined,
      ),
    )
    .orderBy(desc(discoveredProducts.updatedAt))
    .limit(500);
  const analyses = await latestAnalyses(
    db,
    tenantId,
    rows.map((r) => r.p.id),
  );
  return rows.map((r) => toDiscoveredDto(r.p, r.sourceName, r.categoryName, analyses.get(r.p.id)));
};

/** Radar: productos activos ordenados por puntaje, oportunidades primero. */
export const radar = async (db: Database, tenantId: string): Promise<DiscoveredProductDto[]> =>
  (await listDiscovered(db, tenantId))
    .filter((p) => p.status !== 'DISCARDED')
    .sort(
      (a, b) =>
        Number(b.opportunity ?? false) - Number(a.opportunity ?? false) ||
        (b.latestScore ?? -1) - (a.latestScore ?? -1),
    );

const notFuture = (iso: string, now: Date) =>
  new Date(iso).getTime() <= now.getTime() + 60_000
    ? ok(new Date(iso))
    : err(appError('VALIDATION_ERROR', 'La fecha del dato no puede ser futura'));

/** Toda fuente usada debe pertenecer al tenant y estar habilitada. */
const checkSource = async (
  db: Database,
  tenantId: string,
  sourceId: string,
): Promise<Result<ResearchSourceRow>> => {
  const s = await findSource(db, tenantId, sourceId);
  if (!s) return notFound('Fuente');
  if (!s.enabled) return err(appError('CONFLICT', 'La fuente está deshabilitada'));
  return ok(s);
};

export const createDiscovered = async (
  db: Database,
  tenantId: string,
  input: CreateDiscoveredProductRequest,
  now: Date,
): Promise<Result<DiscoveredProductDto>> => {
  const source = await checkSource(db, tenantId, input.sourceId);
  if (!source.ok) return source;
  const observedAt = notFuture(input.observedAt, now);
  if (!observedAt.ok) return observedAt;
  let categoryId: string | null = null;
  let categorySource: 'MANUAL' | 'RULE' | null = null;
  if (input.categoryId) {
    const cats = await listCategoryRows(db, tenantId);
    if (!cats.some((c) => c.id === input.categoryId)) return notFound('Categoría');
    categoryId = input.categoryId;
    categorySource = 'MANUAL';
  } else {
    const suggested = suggestCategory(input.title, await listCategoryRows(db, tenantId));
    if (suggested) {
      categoryId = suggested.id;
      categorySource = 'RULE';
    }
  }
  const id = newId();
  await db.insert(discoveredProducts).values({
    id,
    tenantId,
    title: input.title,
    sourceId: input.sourceId,
    sourceRef: input.sourceRef,
    observedAt: observedAt.value,
    categoryId,
    categorySource,
    createdAt: now,
    updatedAt: now,
  });
  const [dto] = await listDiscovered(db, tenantId, { id });
  return dto ? ok(dto) : notFound('Producto detectado');
};

export const updateDiscovered = async (
  db: Database,
  tenantId: string,
  id: string,
  input: UpdateDiscoveredProductRequest,
  now: Date,
): Promise<Result<DiscoveredProductDto>> => {
  if (!(await findDiscovered(db, tenantId, id))) return notFound('Producto detectado');
  if (
    input.categoryId &&
    !(await listCategoryRows(db, tenantId)).some((c) => c.id === input.categoryId)
  ) {
    return notFound('Categoría');
  }
  if (input.productId && !(await findProduct(db, tenantId, input.productId)))
    return notFound('Producto');
  if (
    input.supplierProductId &&
    !(await findSupplierProduct(db, tenantId, input.supplierProductId))
  ) {
    return notFound('Oferta');
  }
  await db
    .update(discoveredProducts)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.categoryId !== undefined
        ? {
            categoryId: input.categoryId,
            categorySource: input.categoryId ? ('MANUAL' as const) : null,
          }
        : {}),
      ...(input.productId !== undefined ? { productId: input.productId } : {}),
      ...(input.supplierProductId !== undefined
        ? { supplierProductId: input.supplierProductId }
        : {}),
      updatedAt: now,
    })
    .where(eq(discoveredProducts.id, id));
  const [dto] = await listDiscovered(db, tenantId, { id });
  return dto ? ok(dto) : notFound('Producto detectado');
};

export const classifyDiscovered = async (
  db: Database,
  tenantId: string,
  id: string,
  now: Date,
): Promise<Result<DiscoveredProductDto>> => {
  const p = await findDiscovered(db, tenantId, id);
  if (!p) return notFound('Producto detectado');
  const suggested = suggestCategory(p.title, await listCategoryRows(db, tenantId));
  if (!suggested)
    return err(appError('CONFLICT', 'Ninguna categoría coincide con las palabras clave'));
  await db
    .update(discoveredProducts)
    .set({ categoryId: suggested.id, categorySource: 'RULE', updatedAt: now })
    .where(eq(discoveredProducts.id, id));
  const [dto] = await listDiscovered(db, tenantId, { id });
  return dto ? ok(dto) : notFound('Producto detectado');
};

/* ---------- Observaciones (todas con fuente y fecha) ---------- */

const guardObservation = async (
  db: Database,
  tenantId: string,
  id: string,
  input: { sourceId: string; observedAt: string },
  now: Date,
): Promise<Result<Date>> => {
  if (!(await findDiscovered(db, tenantId, id))) return notFound('Producto detectado');
  const source = await checkSource(db, tenantId, input.sourceId);
  if (!source.ok) return source;
  return notFuture(input.observedAt, now);
};

export const recordDemand = async (
  db: Database,
  tenantId: string,
  id: string,
  input: RecordDemandObservationRequest,
  now: Date,
): Promise<Result<{ id: string }>> => {
  const at = await guardObservation(db, tenantId, id, input, now);
  if (!at.ok) return at;
  const obsId = newId();
  await db.insert(demandObservations).values({
    id: obsId,
    tenantId,
    discoveredProductId: id,
    metric: input.metric,
    value: input.value,
    unit: input.unit,
    sourceId: input.sourceId,
    sourceRef: input.sourceRef,
    observedAt: at.value,
    recordedAt: now,
  });
  return ok({ id: obsId });
};

export const recordPrice = async (
  db: Database,
  tenantId: string,
  id: string,
  input: RecordPriceObservationRequest,
  now: Date,
): Promise<Result<{ id: string }>> => {
  const at = await guardObservation(db, tenantId, id, input, now);
  if (!at.ok) return at;
  if (input.competitorId) {
    const c = await db
      .select({ id: competitors.id })
      .from(competitors)
      .where(and(eq(competitors.tenantId, tenantId), eq(competitors.id, input.competitorId)))
      .get();
    if (!c) return notFound('Competidor');
  }
  const obsId = newId();
  await db.insert(priceObservations).values({
    id: obsId,
    tenantId,
    discoveredProductId: id,
    competitorId: input.competitorId ?? null,
    priceCents: input.priceCents,
    currency: input.currency,
    sourceId: input.sourceId,
    sourceRef: input.sourceRef,
    observedAt: at.value,
    recordedAt: now,
  });
  return ok({ id: obsId });
};

export const recordAttribute = async (
  db: Database,
  tenantId: string,
  id: string,
  input: RecordAttributeRequest,
  now: Date,
): Promise<Result<{ id: string }>> => {
  const at = await guardObservation(db, tenantId, id, input, now);
  if (!at.ok) return at;
  const attrId = newId();
  await db.insert(productAttributes).values({
    id: attrId,
    tenantId,
    discoveredProductId: id,
    name: input.name,
    value: input.value,
    verification: input.verification,
    sourceId: input.sourceId,
    sourceRef: input.sourceRef,
    observedAt: at.value,
    recordedAt: now,
  });
  return ok({ id: attrId });
};

export const recordImage = async (
  db: Database,
  tenantId: string,
  id: string,
  input: RecordImageRequest,
  now: Date,
): Promise<Result<{ id: string }>> => {
  if (!(await findDiscovered(db, tenantId, id))) return notFound('Producto detectado');
  const imgId = newId();
  await db.insert(productImages).values({
    id: imgId,
    tenantId,
    discoveredProductId: id,
    url: input.url,
    authorization: input.authorization,
    authorizationRef: input.authorizationRef ?? null,
    recordedAt: now,
  });
  return ok({ id: imgId });
};

/* ---------- Análisis: puntuación + mercado + Risk Guardian ---------- */

const toAnalysisDto = (a: DiscoveryAnalysisRow): AnalysisDto => ({
  score: a.scoreDetail,
  signals: a.signals,
  risk: a.risk,
  analyzedAt: iso(a.analyzedAt),
});

/**
 * Analiza un producto detectado con datos REALES registrados y guarda el resultado.
 * Risk Guardian se evalúa por separado de la puntuación y no la recibe.
 */
export const analyzeDiscovered = async (
  db: Database,
  tenantId: string,
  id: string,
  config: ApiConfig,
  now: Date,
): Promise<Result<AnalysisDto>> => {
  const p = await findDiscovered(db, tenantId, id);
  if (!p) return notFound('Producto detectado');

  const [demand, prices] = await Promise.all([
    db.select().from(demandObservations).where(eq(demandObservations.discoveredProductId, id)),
    db.select().from(priceObservations).where(eq(priceObservations.discoveredProductId, id)),
  ]);

  const offer = p.supplierProductId
    ? await findSupplierProduct(db, tenantId, p.supplierProductId)
    : undefined;
  const supplier = offer
    ? await db.select().from(suppliers).where(eq(suppliers.id, offer.supplierId)).get()
    : undefined;
  const inventory = offer ? await getLatestInventory(db, tenantId, offer.id) : null;
  const product = p.productId ? await findProduct(db, tenantId, p.productId) : undefined;

  // Viabilidad fresca (sin persistir) solo si hay producto + oferta vinculados.
  const evaluation =
    product && offer
      ? await evaluateForProduct(db, tenantId, product.id, offer.id, config, now)
      : null;
  const viability = evaluation?.ok ? evaluation.value.viability : null;

  const currency = product?.currency ?? 'ARS';
  const trend = detectTrend(demand);
  const priceSummary = summarizePrices(
    prices.filter((x) => x.currency === currency),
    now,
  );
  const saturation = detectSaturation(priceSummary, trend.direction);

  const score = computeProductScore({
    marginBps: viability?.breakdown?.marginBps ?? null,
    minMarginBps: config.MIN_NET_MARGIN_BPS,
    supplierScore: supplier?.score ?? null,
    stock: inventory
      ? {
          status: inventory.stockStatus,
          ageHours: (now.getTime() - inventory.checkedAt.getTime()) / 3_600_000,
          maxAgeHours: config.MAX_STOCK_AGE_HOURS,
        }
      : null,
    competitorCount: priceSummary.observations > 0 ? priceSummary.competitorCount : null,
    trend: trend.direction,
    logistics: supplier
      ? {
          deliveryDaysMax: supplier.deliveryTimeDaysMax,
          trackingAvailable: supplier.trackingAvailable,
        }
      : null,
  });
  const opportunity = detectOpportunity({
    score: score.total,
    confidence: score.confidence,
    saturated: saturation.saturated,
    trend: trend.direction,
  });
  const risk = assessRisk({
    hasSupplierOffer: Boolean(offer),
    hasProduct: Boolean(product),
    viability,
    saturated: saturation.saturated,
    confidence: score.confidence,
  });
  if (evaluation && !evaluation.ok) risk.warnings.push(evaluation.error.message);

  const signals = {
    trend: trend.direction,
    trendMetric: trend.metric,
    demandPoints: trend.points,
    competitorCount: priceSummary.competitorCount,
    priceObservations: priceSummary.observations,
    medianPriceCents: priceSummary.medianPriceCents,
    priceChangeBps: priceSummary.priceChangeBps,
    saturated: saturation.saturated,
    saturationReasons: saturation.reasons,
    opportunity: opportunity.opportunity,
    opportunityReasons: opportunity.reasons,
  };

  const row = await db
    .insert(discoveryAnalyses)
    .values({
      id: newId(),
      tenantId,
      discoveredProductId: id,
      score: score.total,
      confidence: score.confidence,
      opportunity: opportunity.opportunity,
      saturated: saturation.saturated,
      riskPassed: risk.passed,
      scoreDetail: score,
      signals,
      risk,
      analyzedAt: now,
    })
    .returning()
    .get();
  return ok(toAnalysisDto(row));
};

export const getDiscoveredDetail = async (
  db: Database,
  tenantId: string,
  id: string,
): Promise<Result<DiscoveredProductDetailDto>> => {
  const [product] = await listDiscovered(db, tenantId, { id });
  if (!product) return notFound('Producto detectado');
  const sourceNames = new Map(
    (await db.select().from(researchSources).where(eq(researchSources.tenantId, tenantId))).map(
      (s) => [s.id, s.name],
    ),
  );
  const [demand, prices, attrs, images, analysis, categories] = await Promise.all([
    db.select().from(demandObservations).where(eq(demandObservations.discoveredProductId, id)),
    db.select().from(priceObservations).where(eq(priceObservations.discoveredProductId, id)),
    db.select().from(productAttributes).where(eq(productAttributes.discoveredProductId, id)),
    db.select().from(productImages).where(eq(productImages.discoveredProductId, id)),
    db
      .select()
      .from(discoveryAnalyses)
      .where(eq(discoveryAnalyses.discoveredProductId, id))
      .orderBy(desc(discoveryAnalyses.analyzedAt))
      .get(),
    listCategoryRows(db, tenantId),
  ]);
  const competitorNames = new Map(
    (await db.select().from(competitors).where(eq(competitors.tenantId, tenantId))).map((c) => [
      c.id,
      c.name,
    ]),
  );
  const base = (o: {
    id: string;
    sourceId: string;
    sourceRef: string;
    observedAt: Date;
    recordedAt: Date;
  }) => ({
    id: o.id,
    sourceId: o.sourceId,
    sourceName: sourceNames.get(o.sourceId) ?? '—',
    sourceRef: o.sourceRef,
    observedAt: iso(o.observedAt),
    recordedAt: iso(o.recordedAt),
  });
  const observations: ObservationDto[] = [
    ...demand.map((d) => ({
      ...base(d),
      kind: 'DEMAND' as const,
      label: d.metric,
      value: `${d.value} ${d.unit}`,
    })),
    ...prices.map((x) => ({
      ...base(x),
      kind: 'PRICE' as const,
      label: x.competitorId
        ? (competitorNames.get(x.competitorId) ?? 'Competidor')
        : 'Precio observado',
      value: `${x.currency} ${(x.priceCents / 100).toFixed(2)}`,
    })),
    ...attrs.map((a) => ({
      ...base(a),
      kind: 'ATTRIBUTE' as const,
      label: a.name,
      value: `${a.value} [${a.verification}]`,
    })),
  ].sort((a, b) => b.observedAt.localeCompare(a.observedAt));

  return ok({
    product,
    observations,
    images: images.map((i) => ({
      id: i.id,
      url: i.url,
      authorization: i.authorization,
      authorizationRef: i.authorizationRef,
    })),
    analysis: analysis ? toAnalysisDto(analysis) : null,
    suggestedCategoryId: suggestCategory(product.title, categories)?.id ?? null,
  });
};

/* ---------- Estado: candidato / descartado ---------- */

/**
 * Promoción a CANDIDATO: corre un análisis nuevo y exige que Risk Guardian pase.
 * La puntuación, por alta que sea, no participa de esta decisión.
 */
export const promoteDiscovered = async (
  db: Database,
  tenantId: string,
  id: string,
  config: ApiConfig,
  now: Date,
): Promise<Result<{ product: DiscoveredProductDto; analysis: AnalysisDto }>> => {
  const p = await findDiscovered(db, tenantId, id);
  if (!p) return notFound('Producto detectado');
  if (p.status !== 'RESEARCHING')
    return err(appError('CONFLICT', 'Solo se promueven productos en investigación'));
  const analysis = await analyzeDiscovered(db, tenantId, id, config, now);
  if (!analysis.ok) return analysis;
  if (!analysis.value.risk.passed) {
    return err(
      appError('CONFLICT', 'Risk Guardian bloquea la promoción', {
        blockers: analysis.value.risk.blockers,
        score: analysis.value.score.total,
      }),
    );
  }
  await db
    .update(discoveredProducts)
    .set({ status: 'CANDIDATE', updatedAt: now })
    .where(eq(discoveredProducts.id, id));
  await db.insert(auditEvents).values({
    id: newId(),
    tenantId,
    action: 'discovery.promoted',
    entityType: 'discovered_product',
    entityId: id,
    metadata: { score: analysis.value.score.total },
    dryRun: true,
    createdAt: now,
  });
  const [dto] = await listDiscovered(db, tenantId, { id });
  return dto ? ok({ product: dto, analysis: analysis.value }) : notFound('Producto detectado');
};

export const setDiscoveryStatus = async (
  db: Database,
  tenantId: string,
  id: string,
  status: 'DISCARDED' | 'RESEARCHING',
  reason: string | null,
  now: Date,
): Promise<Result<DiscoveredProductDto>> => {
  const p = await findDiscovered(db, tenantId, id);
  if (!p) return notFound('Producto detectado');
  if (status === 'RESEARCHING' && p.status === 'RESEARCHING') {
    return err(appError('CONFLICT', 'Ya está en investigación'));
  }
  await db
    .update(discoveredProducts)
    .set({ status, discardReason: status === 'DISCARDED' ? reason : null, updatedAt: now })
    .where(eq(discoveredProducts.id, id));
  const [dto] = await listDiscovered(db, tenantId, { id });
  return dto ? ok(dto) : notFound('Producto detectado');
};

/* ======================= Content Engine ======================= */

const toContentDto = (c: GeneratedContentRow, productTitle: string): GeneratedContentDto => ({
  id: c.id,
  discoveredProductId: c.discoveredProductId,
  productTitle,
  version: c.version,
  templateVersion: c.templateVersion,
  content: c.content,
  compliance: c.compliance,
  createdAt: iso(c.createdAt),
});

/** Genera contenido para un CANDIDATO (ya pasó Risk Guardian) usando solo hechos registrados. */
export const generateForDiscovered = async (
  db: Database,
  tenantId: string,
  id: string,
  now: Date,
): Promise<Result<GeneratedContentDto>> => {
  const p = await findDiscovered(db, tenantId, id);
  if (!p) return notFound('Producto detectado');
  if (p.status !== 'CANDIDATE') {
    return err(appError('CONFLICT', 'Solo se genera contenido para productos candidatos'));
  }
  const [attrs, images] = await Promise.all([
    db.select().from(productAttributes).where(eq(productAttributes.discoveredProductId, id)),
    db.select().from(productImages).where(eq(productImages.discoveredProductId, id)),
  ]);
  const category = p.categoryId
    ? await db.select().from(productCategories).where(eq(productCategories.id, p.categoryId)).get()
    : undefined;
  const product = p.productId ? await findProduct(db, tenantId, p.productId) : undefined;
  const offer = p.supplierProductId
    ? await findSupplierProduct(db, tenantId, p.supplierProductId)
    : undefined;
  const supplier = offer
    ? await db.select().from(suppliers).where(eq(suppliers.id, offer.supplierId)).get()
    : undefined;

  const facts: ContentFacts = {
    title: p.title,
    categoryName: category?.name ?? null,
    attributes: attrs.map((a) => ({ name: a.name, value: a.value, verification: a.verification })),
    salePrice: product ? { cents: product.salePriceCents, currency: product.currency } : null,
    supplier: supplier
      ? {
          directDispatch: supplier.directDispatch,
          deliveryDaysMin: supplier.deliveryTimeDaysMin,
          deliveryDaysMax: supplier.deliveryTimeDaysMax,
          trackingAvailable: supplier.trackingAvailable,
          acceptsReturns: supplier.acceptsReturns,
          returnWindowDays: supplier.returnWindowDays,
        }
      : null,
    images: images.map((i) => ({ url: i.url, authorization: i.authorization })),
  };
  const generated = generateContent(facts);
  const last = await db
    .select({ v: max(generatedContents.version) })
    .from(generatedContents)
    .where(eq(generatedContents.discoveredProductId, id))
    .get();
  const row = await db
    .insert(generatedContents)
    .values({
      id: newId(),
      tenantId,
      discoveredProductId: id,
      version: (last?.v ?? 0) + 1,
      templateVersion: CONTENT_TEMPLATE_VERSION,
      content: generated.content,
      compliance: generated.compliance,
      factsSnapshot: facts as unknown as Record<string, unknown>,
      createdAt: now,
    })
    .returning()
    .get();
  return ok(toContentDto(row, p.title));
};

export const listContents = async (
  db: Database,
  tenantId: string,
  discoveredProductId?: string,
): Promise<GeneratedContentDto[]> => {
  const rows = await db
    .select({ c: generatedContents, title: discoveredProducts.title })
    .from(generatedContents)
    .innerJoin(discoveredProducts, eq(discoveredProducts.id, generatedContents.discoveredProductId))
    .where(
      and(
        eq(generatedContents.tenantId, tenantId),
        discoveredProductId
          ? eq(generatedContents.discoveredProductId, discoveredProductId)
          : undefined,
      ),
    )
    .orderBy(desc(generatedContents.createdAt), desc(generatedContents.version))
    .limit(200);
  return rows.map((r) => toContentDto(r.c, r.title));
};

/** Re-analiza todos los productos activos (lo usa el agente programado). */
export const rescoreActive = async (
  db: Database,
  tenantId: string,
  config: ApiConfig,
  now: Date,
) => {
  const active = await db
    .select({ id: discoveredProducts.id })
    .from(discoveredProducts)
    .where(
      and(
        eq(discoveredProducts.tenantId, tenantId),
        inArray(discoveredProducts.status, ['RESEARCHING', 'CANDIDATE']),
      ),
    )
    .limit(200);
  let analyzed = 0;
  let opportunities = 0;
  for (const { id } of active) {
    const r = await analyzeDiscovered(db, tenantId, id, config, now);
    if (r.ok) {
      analyzed++;
      if (r.value.signals.opportunity) opportunities++;
    }
  }
  return { analyzed, opportunities };
};

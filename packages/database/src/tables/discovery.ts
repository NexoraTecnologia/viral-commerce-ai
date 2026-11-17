import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  Compliance,
  ContentFields,
  MarketSignals,
  ProductScore,
  RiskAssessment,
} from '@vc/shared';
import { epochMsDefault, timestamps } from '../columns';
import { tenants } from '../schema';
import { products, supplierProducts } from './catalog';

const tenantRef = () =>
  text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const recordedAt = () =>
  integer('recorded_at', { mode: 'timestamp_ms' }).notNull().default(epochMsDefault);

/** Fuentes de investigación. El estado efectivo lo informa su adaptador. */
export const researchSources = sqliteTable(
  'research_sources',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    name: text('name').notNull(),
    kind: text('kind', {
      enum: ['GOOGLE_TRENDS', 'PUBLIC_SOURCE', 'COMMERCIAL_API', 'SUPPLIER_CATALOG', 'MANUAL'],
    }).notNull(),
    reference: text('reference'),
    usageAuthorization: text('usage_authorization'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastSyncAt: integer('last_sync_at', { mode: 'timestamp_ms' }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [index('research_sources_tenant_idx').on(t.tenantId)],
);

export const productCategories = sqliteTable(
  'product_categories',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    name: text('name').notNull(),
    keywords: text('keywords', { mode: 'json' }).$type<string[]>().notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('product_categories_tenant_name_uq').on(t.tenantId, t.name)],
);

export const competitors = sqliteTable(
  'competitors',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    name: text('name').notNull(),
    channel: text('channel', {
      enum: ['MARKETPLACE', 'ECOMMERCE', 'SOCIAL', 'RETAIL', 'OTHER'],
    }).notNull(),
    url: text('url'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [index('competitors_tenant_idx').on(t.tenantId)],
);

/** Productos detectados en investigación (aún no son productos propios). */
export const discoveredProducts = sqliteTable(
  'discovered_products',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    title: text('title').notNull(),
    status: text('status', { enum: ['RESEARCHING', 'CANDIDATE', 'DISCARDED'] })
      .notNull()
      .default('RESEARCHING'),
    discardReason: text('discard_reason'),
    categoryId: text('category_id').references(() => productCategories.id, {
      onDelete: 'set null',
    }),
    categorySource: text('category_source', { enum: ['MANUAL', 'RULE'] }),
    sourceId: text('source_id')
      .notNull()
      .references(() => researchSources.id),
    sourceRef: text('source_ref').notNull(),
    observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull(),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    supplierProductId: text('supplier_product_id').references(() => supplierProducts.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    index('discovered_products_tenant_status_idx').on(t.tenantId, t.status),
    index('discovered_products_supplier_product_idx').on(t.supplierProductId),
  ],
);

const discoveredRef = () =>
  text('discovered_product_id')
    .notNull()
    .references(() => discoveredProducts.id, { onDelete: 'cascade' });
const sourceRef = () =>
  text('source_id')
    .notNull()
    .references(() => researchSources.id);

/** Observaciones de demanda tal como las informa la fuente (sin transformar). */
export const demandObservations = sqliteTable(
  'demand_observations',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    discoveredProductId: discoveredRef(),
    metric: text('metric', {
      enum: ['SEARCH_INTEREST', 'SALES_RANK', 'REVIEWS_COUNT', 'UNITS_SOLD', 'OTHER'],
    }).notNull(),
    value: real('value').notNull(),
    unit: text('unit').notNull(),
    sourceId: sourceRef(),
    sourceRef: text('source_ref').notNull(),
    observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull(),
    recordedAt: recordedAt(),
  },
  (t) => [index('demand_observations_product_idx').on(t.discoveredProductId, t.observedAt)],
);

/** Precios observados en el mercado (competidores u otras fuentes). */
export const priceObservations = sqliteTable(
  'price_observations',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    discoveredProductId: discoveredRef(),
    competitorId: text('competitor_id').references(() => competitors.id, { onDelete: 'set null' }),
    priceCents: integer('price_cents').notNull(),
    currency: text('currency', { enum: ['ARS', 'USD'] }).notNull(),
    sourceId: sourceRef(),
    sourceRef: text('source_ref').notNull(),
    observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull(),
    recordedAt: recordedAt(),
  },
  (t) => [index('price_observations_product_idx').on(t.discoveredProductId, t.observedAt)],
);

/** Atributos del producto con procedencia. Solo VERIFIED/SUPPLIER_DECLARED van al contenido. */
export const productAttributes = sqliteTable(
  'product_attributes',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    discoveredProductId: discoveredRef(),
    name: text('name').notNull(),
    value: text('value').notNull(),
    verification: text('verification', {
      enum: ['VERIFIED', 'SUPPLIER_DECLARED', 'UNVERIFIED'],
    }).notNull(),
    sourceId: sourceRef(),
    sourceRef: text('source_ref').notNull(),
    observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull(),
    recordedAt: recordedAt(),
  },
  (t) => [index('product_attributes_product_idx').on(t.discoveredProductId)],
);

/** Imágenes con su autorización de uso. NONE ⇒ nunca se usa. */
export const productImages = sqliteTable(
  'product_images',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    discoveredProductId: discoveredRef(),
    url: text('url').notNull(),
    authorization: text('authorization', {
      enum: ['NONE', 'OWN_PHOTO', 'SUPPLIER_WRITTEN', 'LICENSED'],
    }).notNull(),
    authorizationRef: text('authorization_ref'),
    recordedAt: recordedAt(),
  },
  (t) => [index('product_images_product_idx').on(t.discoveredProductId)],
);

/** Historial de análisis: puntaje, señales de mercado y Risk Guardian (append-only). */
export const discoveryAnalyses = sqliteTable(
  'discovery_analyses',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    discoveredProductId: discoveredRef(),
    score: integer('score').notNull(),
    confidence: real('confidence').notNull(),
    opportunity: integer('opportunity', { mode: 'boolean' }).notNull(),
    saturated: integer('saturated', { mode: 'boolean' }).notNull(),
    riskPassed: integer('risk_passed', { mode: 'boolean' }).notNull(),
    scoreDetail: text('score_detail', { mode: 'json' }).$type<ProductScore>().notNull(),
    signals: text('signals', { mode: 'json' }).$type<MarketSignals>().notNull(),
    risk: text('risk', { mode: 'json' }).$type<RiskAssessment>().notNull(),
    analyzedAt: integer('analyzed_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('discovery_analyses_product_idx').on(t.discoveredProductId, t.analyzedAt)],
);

/** Contenido generado por plantillas, versionado, con la foto de los hechos usados. */
export const generatedContents = sqliteTable(
  'generated_contents',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    discoveredProductId: discoveredRef(),
    version: integer('version').notNull(),
    templateVersion: text('template_version').notNull(),
    content: text('content', { mode: 'json' }).$type<ContentFields>().notNull(),
    compliance: text('compliance', { mode: 'json' }).$type<Compliance>().notNull(),
    factsSnapshot: text('facts_snapshot', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(epochMsDefault),
  },
  (t) => [
    uniqueIndex('generated_contents_product_version_uq').on(t.discoveredProductId, t.version),
  ],
);

export type ResearchSourceRow = typeof researchSources.$inferSelect;
export type DiscoveredProductRow = typeof discoveredProducts.$inferSelect;
export type DiscoveryAnalysisRow = typeof discoveryAnalyses.$inferSelect;
export type GeneratedContentRow = typeof generatedContents.$inferSelect;

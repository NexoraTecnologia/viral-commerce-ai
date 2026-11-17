import { z } from 'zod';
import { CurrencySchema } from '../money';
import { CentsSchema, IsoDateTimeSchema } from './common';

/* ---------- Fuentes de investigación ---------- */

export const SourceKindSchema = z.enum([
  'GOOGLE_TRENDS',
  'PUBLIC_SOURCE',
  'COMMERCIAL_API',
  'SUPPLIER_CATALOG',
  'MANUAL',
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/** Una fuente sin conector operativo se informa como NOT_CONFIGURED (nunca se simulan datos). */
export const SourceStatusSchema = z.enum(['NOT_CONFIGURED', 'CONFIGURED', 'ERROR', 'DISABLED']);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const CreateSourceRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  kind: SourceKindSchema,
  /** URL o descripción de la fuente (p. ej. sitio público consultado). */
  reference: z.string().trim().max(500).optional(),
  /** Base legal / autorización de uso de los datos (términos, contrato, permiso). */
  usageAuthorization: z.string().trim().max(1000).optional(),
});
export type CreateSourceRequest = z.infer<typeof CreateSourceRequestSchema>;

export const SourceDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: SourceKindSchema,
  status: SourceStatusSchema,
  statusDetail: z.string().nullable(),
  reference: z.string().nullable(),
  usageAuthorization: z.string().nullable(),
  enabled: z.boolean(),
  lastSyncAt: IsoDateTimeSchema.nullable(),
  lastError: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type SourceDto = z.infer<typeof SourceDtoSchema>;

export const SourceSyncResultSchema = z.object({
  sourceId: z.uuid(),
  status: SourceStatusSchema,
  message: z.string(),
  created: z.number().int(),
});
export type SourceSyncResult = z.infer<typeof SourceSyncResultSchema>;

/* ---------- Categorías y competidores ---------- */

export const CreateCategoryRequestSchema = z.object({
  name: z.string().trim().min(2).max(80),
  /** Palabras clave para la clasificación automática por título. */
  keywords: z.array(z.string().trim().min(2).max(40)).max(50).default([]),
});
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequestSchema>;

export const CategoryDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  keywords: z.array(z.string()),
});
export type CategoryDto = z.infer<typeof CategoryDtoSchema>;

export const CompetitorChannelSchema = z.enum([
  'MARKETPLACE',
  'ECOMMERCE',
  'SOCIAL',
  'RETAIL',
  'OTHER',
]);

export const CreateCompetitorRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  channel: CompetitorChannelSchema,
  url: z.url().optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type CreateCompetitorRequest = z.infer<typeof CreateCompetitorRequestSchema>;

export const CompetitorDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  channel: CompetitorChannelSchema,
  url: z.string().nullable(),
  notes: z.string().nullable(),
});
export type CompetitorDto = z.infer<typeof CompetitorDtoSchema>;

/* ---------- Productos detectados ---------- */

export const DiscoveryStatusSchema = z.enum(['RESEARCHING', 'CANDIDATE', 'DISCARDED']);
export type DiscoveryStatus = z.infer<typeof DiscoveryStatusSchema>;

/** Toda observación declara fuente y fecha. */
const provenance = {
  sourceId: z.uuid(),
  /** URL, ID de publicación o referencia verificable del dato. */
  sourceRef: z.string().trim().min(1).max(500),
  observedAt: IsoDateTimeSchema,
};

export const CreateDiscoveredProductRequestSchema = z.object({
  title: z.string().trim().min(2).max(300),
  categoryId: z.uuid().optional(),
  ...provenance,
});
export type CreateDiscoveredProductRequest = z.infer<typeof CreateDiscoveredProductRequestSchema>;

export const UpdateDiscoveredProductRequestSchema = z.object({
  title: z.string().trim().min(2).max(300).optional(),
  categoryId: z.uuid().nullable().optional(),
  productId: z.uuid().nullable().optional(),
  supplierProductId: z.uuid().nullable().optional(),
});
export type UpdateDiscoveredProductRequest = z.infer<typeof UpdateDiscoveredProductRequestSchema>;

export const DemandMetricSchema = z.enum([
  'SEARCH_INTEREST',
  'SALES_RANK',
  'REVIEWS_COUNT',
  'UNITS_SOLD',
  'OTHER',
]);
export type DemandMetric = z.infer<typeof DemandMetricSchema>;

export const RecordDemandObservationRequestSchema = z.object({
  metric: DemandMetricSchema,
  value: z.number().min(0),
  /** Unidad o escala tal como la informa la fuente (p. ej. "índice 0-100"). */
  unit: z.string().trim().min(1).max(60),
  ...provenance,
});
export type RecordDemandObservationRequest = z.infer<typeof RecordDemandObservationRequestSchema>;

export const RecordPriceObservationRequestSchema = z.object({
  priceCents: CentsSchema.refine((v) => v > 0, 'El precio debe ser mayor a 0'),
  currency: CurrencySchema,
  competitorId: z.uuid().optional(),
  ...provenance,
});
export type RecordPriceObservationRequest = z.infer<typeof RecordPriceObservationRequestSchema>;

/** Cómo se sabe que un atributo es cierto. Los UNVERIFIED nunca llegan al contenido. */
export const AttributeVerificationSchema = z.enum(['VERIFIED', 'SUPPLIER_DECLARED', 'UNVERIFIED']);
export type AttributeVerification = z.infer<typeof AttributeVerificationSchema>;

export const RecordAttributeRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(200),
  verification: AttributeVerificationSchema,
  ...provenance,
});
export type RecordAttributeRequest = z.infer<typeof RecordAttributeRequestSchema>;

/** Autorización de uso de imágenes. NONE ⇒ la imagen no se usa en contenido. */
export const ImageAuthorizationSchema = z.enum([
  'NONE',
  'OWN_PHOTO',
  'SUPPLIER_WRITTEN',
  'LICENSED',
]);
export type ImageAuthorization = z.infer<typeof ImageAuthorizationSchema>;

export const RecordImageRequestSchema = z
  .object({
    url: z.url(),
    authorization: ImageAuthorizationSchema,
    /** Evidencia de la autorización (n.º de licencia, email del proveedor, etc.). */
    authorizationRef: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.authorization === 'NONE' || (v.authorizationRef ?? '').length >= 3, {
    message: 'Una imagen autorizada requiere referencia de la autorización',
  });
export type RecordImageRequest = z.infer<typeof RecordImageRequestSchema>;

export const DiscardRequestSchema = z.object({ reason: z.string().trim().min(3).max(500) });

/* ---------- Análisis: tendencia, puntuación, riesgo ---------- */

export const TrendDirectionSchema = z.enum(['RISING', 'STABLE', 'FALLING', 'INSUFFICIENT_DATA']);
export type TrendDirection = z.infer<typeof TrendDirectionSchema>;

export const ScoreComponentNameSchema = z.enum([
  'PROFITABILITY',
  'SUPPLIER_RELIABILITY',
  'AVAILABILITY',
  'COMPETITION',
  'DEMAND',
  'LOGISTICS',
]);
export type ScoreComponentName = z.infer<typeof ScoreComponentNameSchema>;

export const ScoreComponentSchema = z.object({
  name: ScoreComponentNameSchema,
  weight: z.number().int(),
  /** null = sin datos: no se inventa un valor y aporta 0 al total. */
  value: z.number().int().min(0).max(100).nullable(),
  basis: z.string(),
});
export type ScoreComponent = z.infer<typeof ScoreComponentSchema>;

export const ProductScoreSchema = z.object({
  total: z.number().int().min(0).max(100),
  /** Fracción del peso con datos reales (0..1). */
  confidence: z.number().min(0).max(1),
  components: z.array(ScoreComponentSchema),
});
export type ProductScore = z.infer<typeof ProductScoreSchema>;

export const RiskCheckSchema = z.enum([
  'SUPPLIER_LINKED',
  'PRODUCT_LINKED',
  'SUPPLIER_VERIFIED',
  'STOCK_CONFIRMED',
  'PRICE_CURRENT',
  'CURRENCY_MATCH',
  'MIN_MARGIN',
]);
export type RiskCheck = z.infer<typeof RiskCheckSchema>;

export const RiskAssessmentSchema = z.object({
  passed: z.boolean(),
  blockers: z.array(RiskCheckSchema),
  warnings: z.array(z.string()),
});
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

export const MarketSignalsSchema = z.object({
  trend: TrendDirectionSchema,
  trendMetric: DemandMetricSchema.nullable(),
  demandPoints: z.number().int(),
  competitorCount: z.number().int(),
  priceObservations: z.number().int(),
  medianPriceCents: z.number().int().nullable(),
  priceChangeBps: z.number().int().nullable(),
  saturated: z.boolean(),
  saturationReasons: z.array(z.string()),
  opportunity: z.boolean(),
  opportunityReasons: z.array(z.string()),
});
export type MarketSignals = z.infer<typeof MarketSignalsSchema>;

export const AnalysisDtoSchema = z.object({
  score: ProductScoreSchema,
  signals: MarketSignalsSchema,
  risk: RiskAssessmentSchema,
  analyzedAt: IsoDateTimeSchema,
});
export type AnalysisDto = z.infer<typeof AnalysisDtoSchema>;

export const ObservationDtoSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['DEMAND', 'PRICE', 'ATTRIBUTE']),
  label: z.string(),
  value: z.string(),
  sourceId: z.uuid(),
  sourceName: z.string(),
  sourceRef: z.string(),
  observedAt: IsoDateTimeSchema,
  recordedAt: IsoDateTimeSchema,
});
export type ObservationDto = z.infer<typeof ObservationDtoSchema>;

export const DiscoveredProductDtoSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: DiscoveryStatusSchema,
  discardReason: z.string().nullable(),
  categoryId: z.uuid().nullable(),
  categoryName: z.string().nullable(),
  categorySource: z.enum(['MANUAL', 'RULE']).nullable(),
  sourceId: z.uuid(),
  sourceName: z.string(),
  sourceRef: z.string(),
  observedAt: IsoDateTimeSchema,
  productId: z.uuid().nullable(),
  supplierProductId: z.uuid().nullable(),
  latestScore: z.number().int().nullable(),
  latestConfidence: z.number().nullable(),
  opportunity: z.boolean().nullable(),
  saturated: z.boolean().nullable(),
  riskPassed: z.boolean().nullable(),
  analyzedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type DiscoveredProductDto = z.infer<typeof DiscoveredProductDtoSchema>;

export const ImageDtoSchema = z.object({
  id: z.uuid(),
  url: z.string(),
  authorization: ImageAuthorizationSchema,
  authorizationRef: z.string().nullable(),
});
export type ImageDto = z.infer<typeof ImageDtoSchema>;

export const DiscoveredProductDetailDtoSchema = z.object({
  product: DiscoveredProductDtoSchema,
  observations: z.array(ObservationDtoSchema),
  images: z.array(ImageDtoSchema),
  analysis: AnalysisDtoSchema.nullable(),
  suggestedCategoryId: z.uuid().nullable(),
});
export type DiscoveredProductDetailDto = z.infer<typeof DiscoveredProductDetailDtoSchema>;

/* ---------- Contenido ---------- */

export const ContentFieldsSchema = z.object({
  commercialName: z.string(),
  seoTitle: z.string(),
  description: z.string(),
  features: z.array(z.string()),
  benefits: z.array(z.string()),
  faq: z.array(z.object({ question: z.string(), answer: z.string() })),
  instagram: z.string(),
  whatsapp: z.string(),
  storeDescription: z.string(),
  marketplaceDescription: z.string(),
  images: z.array(z.string()),
});
export type ContentFields = z.infer<typeof ContentFieldsSchema>;

export const ComplianceSchema = z.object({
  ok: z.boolean(),
  violations: z.array(z.object({ field: z.string(), term: z.string(), rule: z.string() })),
  excludedAttributes: z.number().int(),
  excludedImages: z.number().int(),
});
export type Compliance = z.infer<typeof ComplianceSchema>;

export const GeneratedContentDtoSchema = z.object({
  id: z.uuid(),
  discoveredProductId: z.uuid(),
  productTitle: z.string(),
  version: z.number().int(),
  templateVersion: z.string(),
  content: ContentFieldsSchema,
  compliance: ComplianceSchema,
  createdAt: IsoDateTimeSchema,
});
export type GeneratedContentDto = z.infer<typeof GeneratedContentDtoSchema>;

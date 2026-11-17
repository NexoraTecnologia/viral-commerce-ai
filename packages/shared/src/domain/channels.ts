import { z } from 'zod';
import { BpsSchema, CentsSchema, IsoDateTimeSchema } from './common';
import { CurrencySchema } from '../money';

/* ============================ Canales y conexiones ============================ */

export const ChannelKindSchema = z.enum([
  'MERCADO_LIBRE',
  'INSTAGRAM',
  'WHATSAPP',
  'OWN_STORE',
  'AFFILIATE',
]);
export type ChannelKind = z.infer<typeof ChannelKindSchema>;

/** Estado de una conexión. Nunca se informa CONNECTED sin una verificación real (o MOCK explícito). */
export const ConnectionStatusSchema = z.enum([
  'NOT_CONFIGURED',
  'CONNECTED',
  'EXPIRED',
  'ERROR',
  'DISABLED',
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

/** LIVE = API oficial real. MOCK = simulación local, sin red y sin efectos. */
export const ConnectionModeSchema = z.enum(['LIVE', 'MOCK']);
export type ConnectionMode = z.infer<typeof ConnectionModeSchema>;

export const CHANNEL_OPERATIONS = [
  'connect',
  'disconnect',
  'getConnectionStatus',
  'getCatalog',
  'createListing',
  'updateListing',
  'pauseListing',
  'getOrders',
  'getOrderStatus',
  'handleWebhook',
] as const;
export const ChannelOperationSchema = z.enum(CHANNEL_OPERATIONS);
export type ChannelOperation = z.infer<typeof ChannelOperationSchema>;

/**
 * SUPPORTED: la API oficial lo permite. UNSUPPORTED: la API no lo ofrece (no se
 * simula). LOCAL_ONLY: se resuelve en nuestro sistema, sin llamada externa.
 */
export const CapabilitySupportSchema = z.enum(['SUPPORTED', 'UNSUPPORTED', 'LOCAL_ONLY']);
export type CapabilitySupport = z.infer<typeof CapabilitySupportSchema>;

export const CapabilitySchema = z.object({
  support: CapabilitySupportSchema,
  note: z.string(),
});
export type Capability = z.infer<typeof CapabilitySchema>;
export type ChannelCapabilities = Readonly<Record<ChannelOperation, Capability>>;

export const ChannelConnectionDtoSchema = z.object({
  id: z.uuid(),
  channel: ChannelKindSchema,
  mode: ConnectionModeSchema,
  status: ConnectionStatusSchema,
  statusDetail: z.string(),
  displayName: z.string(),
  externalAccountId: z.string().nullable(),
  externalAccountName: z.string().nullable(),
  scopes: z.array(z.string()),
  tokenExpiresAt: IsoDateTimeSchema.nullable(),
  lastCheckedAt: IsoDateTimeSchema.nullable(),
  lastError: z.string().nullable(),
  capabilities: z.record(ChannelOperationSchema, CapabilitySchema),
  createdAt: IsoDateTimeSchema,
});
export type ChannelConnectionDto = z.infer<typeof ChannelConnectionDtoSchema>;

export const CreateConnectionRequestSchema = z.object({
  channel: ChannelKindSchema,
  mode: ConnectionModeSchema,
  displayName: z.string().trim().min(2).max(120),
});
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequestSchema>;

/**
 * Conexión por token (WhatsApp Cloud API: token de usuario del sistema emitido por
 * el propio negocio en Meta Business). El token se valida contra la API y se cifra.
 */
export const ConnectWithTokenRequestSchema = z.object({
  accessToken: z.string().trim().min(20).max(4096),
  phoneNumberId: z.string().regex(/^\d{5,32}$/, 'ID de número inválido'),
  businessAccountId: z
    .string()
    .regex(/^\d{5,32}$/)
    .optional(),
});
export type ConnectWithTokenRequest = z.infer<typeof ConnectWithTokenRequestSchema>;

export const OAuthStartResponseSchema = z.object({ authorizationUrl: z.url() });
export type OAuthStartResponse = z.infer<typeof OAuthStartResponseSchema>;

/* ================================ Publicaciones ================================ */

export const ListingStatusSchema = z.enum([
  'DRAFT',
  'READY',
  'BLOCKED',
  'PUBLISHED',
  'PAUSED',
  'ERROR',
]);
export type ListingStatus = z.infer<typeof ListingStatusSchema>;

/** Borrador neutral: cada adaptador lo traduce al formato de su API. */
export const ListingDraftSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(50_000),
  priceCents: CentsSchema,
  currency: CurrencySchema,
  quantity: z.number().int().min(0).max(1_000_000),
  imageUrls: z.array(z.url()).max(20),
  caption: z.string().max(5000).nullable(),
  /** Mercado Libre: categoría del sitio (p. ej. MLA1234). Requerida para publicar ahí. */
  categoryId: z.string().max(40).nullable(),
  listingTypeId: z.string().max(40).nullable(),
  condition: z.enum(['new', 'used']).nullable(),
});
export type ListingDraft = z.infer<typeof ListingDraftSchema>;

export const PublishCheckSchema = z.enum([
  'SUPPLIER_VERIFIED',
  'STOCK_VERIFIABLE',
  'MIN_MARGIN',
  'LOGISTICS_CAPACITY',
  'CHANNEL_POLICY',
  'RISK_GUARDIAN',
  'INTEGRATION_AUTHORIZED',
  'COMMERCIAL_ACTIONS_ENABLED',
]);
export type PublishCheck = z.infer<typeof PublishCheckSchema>;

export const PublishGateResultSchema = z.object({
  /** Publicación real permitida (todas las condiciones). */
  allowed: z.boolean(),
  /** Publicación simulada permitida en una conexión MOCK (todo salvo integración/interruptor). */
  allowedInMock: z.boolean(),
  checks: z.array(z.object({ check: PublishCheckSchema, passed: z.boolean(), detail: z.string() })),
  evaluatedAt: IsoDateTimeSchema,
});
export type PublishGateResult = z.infer<typeof PublishGateResultSchema>;

export const ChannelListingDtoSchema = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  channel: ChannelKindSchema,
  mode: ConnectionModeSchema,
  discoveredProductId: z.uuid().nullable(),
  productId: z.uuid().nullable(),
  status: ListingStatusSchema,
  externalId: z.string().nullable(),
  externalUrl: z.string().nullable(),
  draft: ListingDraftSchema,
  gate: PublishGateResultSchema.nullable(),
  lastError: z.string().nullable(),
  publishedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ChannelListingDto = z.infer<typeof ChannelListingDtoSchema>;

export const PrepareListingRequestSchema = z.object({
  connectionId: z.uuid(),
  discoveredProductId: z.uuid(),
  contentId: z.uuid().optional(),
  categoryId: z.string().trim().max(40).optional(),
  listingTypeId: z.string().trim().max(40).optional(),
  quantity: z.number().int().min(0).max(1_000_000).optional(),
  condition: z.enum(['new', 'used']).optional(),
});
export type PrepareListingRequest = z.infer<typeof PrepareListingRequestSchema>;

/* =================================== Pedidos =================================== */

export const OrderStatusSchema = z.enum([
  'CONFIRMED',
  'PAYMENT_PENDING',
  'PAID',
  'CANCELLED',
  'OTHER',
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const ChannelOrderDtoSchema = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  channel: ChannelKindSchema,
  mode: ConnectionModeSchema,
  externalOrderId: z.string(),
  status: OrderStatusSchema,
  rawStatus: z.string(),
  totalCents: z.number().int().nullable(),
  currency: z.string().nullable(),
  placedAt: IsoDateTimeSchema.nullable(),
  syncedAt: IsoDateTimeSchema,
});
export type ChannelOrderDto = z.infer<typeof ChannelOrderDtoSchema>;

/* ============================ Webhooks, logs y mensajes ============================ */

export const WebhookEventStatusSchema = z.enum([
  'RECEIVED',
  'PROCESSED',
  'IGNORED',
  'FAILED',
  'REJECTED',
]);
export type WebhookEventStatus = z.infer<typeof WebhookEventStatusSchema>;

export const WebhookEventDtoSchema = z.object({
  id: z.uuid(),
  channel: ChannelKindSchema,
  connectionId: z.uuid().nullable(),
  topic: z.string(),
  resource: z.string().nullable(),
  status: WebhookEventStatusSchema,
  detail: z.string().nullable(),
  receivedAt: IsoDateTimeSchema,
  processedAt: IsoDateTimeSchema.nullable(),
});
export type WebhookEventDto = z.infer<typeof WebhookEventDtoSchema>;

export const IntegrationOutcomeSchema = z.enum(['OK', 'ERROR', 'BLOCKED', 'UNSUPPORTED']);
export type IntegrationOutcome = z.infer<typeof IntegrationOutcomeSchema>;

export const IntegrationLogDtoSchema = z.object({
  id: z.uuid(),
  connectionId: z.uuid().nullable(),
  channel: ChannelKindSchema,
  operation: z.string(),
  outcome: IntegrationOutcomeSchema,
  errorCode: z.string().nullable(),
  message: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type IntegrationLogDto = z.infer<typeof IntegrationLogDtoSchema>;

export const MessageDirectionSchema = z.enum(['INBOUND', 'OUTBOUND']);
export const MessageKindSchema = z.enum(['TEXT', 'TEMPLATE', 'QUESTION', 'ANSWER', 'OTHER']);
export const MessageStatusSchema = z.enum([
  'RECEIVED',
  'DRAFT',
  'BLOCKED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const ChannelMessageDtoSchema = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  channel: ChannelKindSchema,
  direction: MessageDirectionSchema,
  kind: MessageKindSchema,
  externalId: z.string().nullable(),
  contactRef: z.string(),
  body: z.string(),
  status: MessageStatusSchema,
  detail: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type ChannelMessageDto = z.infer<typeof ChannelMessageDtoSchema>;

export const PrepareMessageRequestSchema = z
  .object({
    connectionId: z.uuid(),
    /** WhatsApp: teléfono o BSUID del contacto. Mercado Libre: ID de la pregunta. */
    contactRef: z.string().trim().min(1).max(64),
    text: z.string().trim().min(1).max(4096).optional(),
    template: z
      .object({
        name: z.string().regex(/^[a-z0-9_]{1,512}$/),
        languageCode: z.string().min(2).max(15),
        parameters: z.array(z.string().max(1024)).max(20).default([]),
      })
      .optional(),
  })
  .refine((v) => (v.text === undefined) !== (v.template === undefined), {
    message: 'Indicar texto o plantilla (uno solo)',
  });
export type PrepareMessageRequest = z.infer<typeof PrepareMessageRequestSchema>;

/* ================================== Afiliados ================================== */

export const ConversionStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PAID']);
export type ConversionStatus = z.infer<typeof ConversionStatusSchema>;

export const AffiliateNetworkDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  website: z.string().nullable(),
  status: ConnectionStatusSchema,
  statusDetail: z.string(),
  termsRef: z.string().nullable(),
  cookieDays: z.number().int().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type AffiliateNetworkDto = z.infer<typeof AffiliateNetworkDtoSchema>;

export const CreateAffiliateNetworkRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  website: z.url().optional(),
  termsRef: z.string().trim().max(500).optional(),
  cookieDays: z.number().int().min(0).max(365).optional(),
});
export type CreateAffiliateNetworkRequest = z.infer<typeof CreateAffiliateNetworkRequestSchema>;

const HttpsUrlSchema = z.url({ protocol: /^https$/, error: 'Debe ser una URL https' });

export const AffiliateProductDtoSchema = z.object({
  id: z.uuid(),
  networkId: z.uuid(),
  title: z.string(),
  productUrl: z.string(),
  externalRef: z.string().nullable(),
  commissionRateBps: z.number().int().nullable(),
  commissionSourceRef: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type AffiliateProductDto = z.infer<typeof AffiliateProductDtoSchema>;

export const CreateAffiliateProductRequestSchema = z
  .object({
    networkId: z.uuid(),
    title: z.string().trim().min(2).max(200),
    productUrl: HttpsUrlSchema,
    externalRef: z.string().trim().max(120).optional(),
    commissionRateBps: BpsSchema.optional(),
    /** De dónde sale la tasa (contrato, panel de la red). Obligatorio si hay tasa. */
    commissionSourceRef: z.string().trim().min(3).max(500).optional(),
  })
  .refine((v) => v.commissionRateBps === undefined || v.commissionSourceRef !== undefined, {
    message: 'La tasa de comisión requiere indicar su fuente',
    path: ['commissionSourceRef'],
  });
export type CreateAffiliateProductRequest = z.infer<typeof CreateAffiliateProductRequestSchema>;

export const AffiliateLinkDtoSchema = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  networkId: z.uuid(),
  code: z.string(),
  destinationUrl: z.string(),
  campaign: z.string().nullable(),
  channel: ChannelKindSchema.nullable(),
  active: z.boolean(),
  clicks: z.number().int(),
  conversions: z.number().int(),
  createdAt: IsoDateTimeSchema,
});
export type AffiliateLinkDto = z.infer<typeof AffiliateLinkDtoSchema>;

export const CreateAffiliateLinkRequestSchema = z.object({
  productId: z.uuid(),
  /** Enlace de seguimiento emitido por la red (no se fabrica). */
  destinationUrl: HttpsUrlSchema,
  campaign: z.string().trim().max(80).optional(),
  channel: ChannelKindSchema.optional(),
});
export type CreateAffiliateLinkRequest = z.infer<typeof CreateAffiliateLinkRequestSchema>;

export const AffiliateConversionDtoSchema = z.object({
  id: z.uuid(),
  linkId: z.uuid(),
  networkId: z.uuid(),
  externalRef: z.string(),
  saleCents: z.number().int(),
  currency: CurrencySchema,
  commissionCents: z.number().int(),
  status: ConversionStatusSchema,
  source: z.enum(['MANUAL', 'NETWORK_REPORT']),
  sourceRef: z.string(),
  occurredAt: IsoDateTimeSchema,
  recordedAt: IsoDateTimeSchema,
});
export type AffiliateConversionDto = z.infer<typeof AffiliateConversionDtoSchema>;

export const RecordConversionRequestSchema = z.object({
  linkId: z.uuid(),
  externalRef: z.string().trim().min(1).max(120),
  saleCents: CentsSchema,
  currency: CurrencySchema,
  /** Si se omite, se calcula con la tasa registrada (con fuente) del producto. */
  commissionCents: CentsSchema.optional(),
  status: ConversionStatusSchema.default('PENDING'),
  /** Reporte de la red o comprobante que respalda la conversión. */
  sourceRef: z.string().trim().min(3).max(500),
  occurredAt: IsoDateTimeSchema,
});
export type RecordConversionRequest = z.input<typeof RecordConversionRequestSchema>;

export const UpdateConversionStatusRequestSchema = z.object({ status: ConversionStatusSchema });

export const AffiliateSummaryDtoSchema = z.object({
  clicks: z.number().int(),
  conversions: z.number().int(),
  /** null si no hay clics: no se informa una tasa sin datos. */
  conversionRateBps: z.number().int().nullable(),
  commissions: z.array(
    z.object({
      currency: CurrencySchema,
      status: ConversionStatusSchema,
      totalCents: z.number().int(),
    }),
  ),
});
export type AffiliateSummaryDto = z.infer<typeof AffiliateSummaryDtoSchema>;

/* ================================ Tienda propia ================================ */

export const StoreProductDtoSchema = z.object({
  listingId: z.uuid(),
  title: z.string(),
  description: z.string(),
  priceCents: z.number().int(),
  currency: CurrencySchema,
  imageUrls: z.array(z.string()),
  /** true = vista previa de una publicación MOCK/no publicada: no se puede comprar. */
  preview: z.boolean(),
});
export type StoreProductDto = z.infer<typeof StoreProductDtoSchema>;

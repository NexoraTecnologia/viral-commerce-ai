import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ListingDraft, PublishGateResult } from '@vc/shared';
import { epochMsDefault, timestamps } from '../columns';
import { tenants } from '../schema';
import { products } from './catalog';
import { discoveredProducts, generatedContents } from './discovery';

const CHANNEL = ['MERCADO_LIBRE', 'INSTAGRAM', 'WHATSAPP', 'OWN_STORE', 'AFFILIATE'] as const;
const CONNECTION_STATUS = ['NOT_CONFIGURED', 'CONNECTED', 'EXPIRED', 'ERROR', 'DISABLED'] as const;
const CURRENCY = ['ARS', 'USD'] as const;

const tenantRef = () =>
  text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const ms = (name: string) => integer(name, { mode: 'timestamp_ms' });

/**
 * Conexiones a canales. Los tokens se guardan CIFRADOS (AES-GCM, clave en secret)
 * y nunca se devuelven por la API.
 */
export const channelConnections = sqliteTable(
  'channel_connections',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    channel: text('channel', { enum: CHANNEL }).notNull(),
    mode: text('mode', { enum: ['LIVE', 'MOCK'] }).notNull(),
    status: text('status', { enum: CONNECTION_STATUS }).notNull().default('NOT_CONFIGURED'),
    statusDetail: text('status_detail').notNull().default(''),
    displayName: text('display_name').notNull(),
    externalAccountId: text('external_account_id'),
    externalAccountName: text('external_account_name'),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull(),
    accessTokenEnc: text('access_token_enc'),
    refreshTokenEnc: text('refresh_token_enc'),
    tokenExpiresAt: ms('token_expires_at'),
    lastCheckedAt: ms('last_checked_at'),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    index('channel_connections_tenant_idx').on(t.tenantId),
    index('channel_connections_account_idx').on(t.channel, t.externalAccountId),
  ],
);

/** state OAuth de un solo uso (se guarda el hash; el code_verifier va cifrado). */
export const oauthStates = sqliteTable('oauth_states', {
  id: text('id').primaryKey(),
  tenantId: tenantRef(),
  connectionId: text('connection_id')
    .notNull()
    .references(() => channelConnections.id, { onDelete: 'cascade' }),
  stateHash: text('state_hash').notNull().unique(),
  codeVerifierEnc: text('code_verifier_enc'),
  redirectUri: text('redirect_uri').notNull(),
  expiresAt: ms('expires_at').notNull(),
  usedAt: ms('used_at'),
  createdAt: timestamps.createdAt,
});

export const channelListings = sqliteTable(
  'channel_listings',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => channelConnections.id, { onDelete: 'cascade' }),
    discoveredProductId: text('discovered_product_id').references(() => discoveredProducts.id, {
      onDelete: 'set null',
    }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    contentId: text('content_id').references(() => generatedContents.id, { onDelete: 'set null' }),
    status: text('status', {
      enum: ['DRAFT', 'READY', 'BLOCKED', 'PUBLISHED', 'PAUSED', 'ERROR'],
    })
      .notNull()
      .default('DRAFT'),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    draft: text('draft', { mode: 'json' }).$type<ListingDraft>().notNull(),
    gate: text('gate', { mode: 'json' }).$type<PublishGateResult>(),
    idempotencyKey: text('idempotency_key').notNull(),
    lastError: text('last_error'),
    publishedAt: ms('published_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('channel_listings_idem_uq').on(t.tenantId, t.idempotencyKey),
    index('channel_listings_conn_idx').on(t.connectionId, t.status),
  ],
);

export const channelOrders = sqliteTable(
  'channel_orders',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => channelConnections.id, { onDelete: 'cascade' }),
    externalOrderId: text('external_order_id').notNull(),
    status: text('status', {
      enum: ['CONFIRMED', 'PAYMENT_PENDING', 'PAID', 'CANCELLED', 'OTHER'],
    }).notNull(),
    rawStatus: text('raw_status').notNull(),
    totalCents: integer('total_cents'),
    currency: text('currency'),
    placedAt: ms('placed_at'),
    syncedAt: ms('synced_at').notNull(),
  },
  (t) => [uniqueIndex('channel_orders_ext_uq').on(t.connectionId, t.externalOrderId)],
);

/** Webhooks recibidos. La unicidad (canal, dedupe_key) da idempotencia ante reintentos. */
export const webhookEvents = sqliteTable(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: CHANNEL }).notNull(),
    connectionId: text('connection_id').references(() => channelConnections.id, {
      onDelete: 'set null',
    }),
    dedupeKey: text('dedupe_key').notNull(),
    topic: text('topic').notNull(),
    resource: text('resource'),
    /** Payload ya redactado. */
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    status: text('status', {
      enum: ['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED', 'REJECTED'],
    }).notNull(),
    detail: text('detail'),
    receivedAt: ms('received_at').notNull(),
    processedAt: ms('processed_at'),
  },
  (t) => [
    uniqueIndex('webhook_events_dedupe_uq').on(t.channel, t.dedupeKey),
    index('webhook_events_tenant_idx').on(t.tenantId, t.receivedAt),
  ],
);

/** Registro de operaciones contra canales (errores incluidos), sin secretos. */
export const integrationLogs = sqliteTable(
  'integration_logs',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    connectionId: text('connection_id').references(() => channelConnections.id, {
      onDelete: 'set null',
    }),
    channel: text('channel', { enum: CHANNEL }).notNull(),
    operation: text('operation').notNull(),
    outcome: text('outcome', { enum: ['OK', 'ERROR', 'BLOCKED', 'UNSUPPORTED'] }).notNull(),
    errorCode: text('error_code'),
    message: text('message'),
    httpStatus: integer('http_status'),
    durationMs: integer('duration_ms'),
    createdAt: ms('created_at').notNull().default(epochMsDefault),
  },
  (t) => [index('integration_logs_tenant_idx').on(t.tenantId, t.createdAt)],
);

/** Ventanas de rate limiting por conexión y operación (persistidas en D1). */
export const rateLimitWindows = sqliteTable('rate_limit_windows', {
  key: text('key').primaryKey(),
  tenantId: tenantRef(),
  windowStart: integer('window_start').notNull(),
  count: integer('count').notNull(),
});

export const channelMessages = sqliteTable(
  'channel_messages',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => channelConnections.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: CHANNEL }).notNull(),
    direction: text('direction', { enum: ['INBOUND', 'OUTBOUND'] }).notNull(),
    kind: text('kind', { enum: ['TEXT', 'TEMPLATE', 'QUESTION', 'ANSWER', 'OTHER'] }).notNull(),
    externalId: text('external_id'),
    contactRef: text('contact_ref').notNull(),
    body: text('body').notNull(),
    status: text('status', {
      enum: ['RECEIVED', 'DRAFT', 'BLOCKED', 'SENT', 'DELIVERED', 'READ', 'FAILED'],
    }).notNull(),
    detail: text('detail'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('channel_messages_ext_uq').on(t.connectionId, t.externalId),
    index('channel_messages_contact_idx').on(t.connectionId, t.contactRef, t.createdAt),
  ],
);

/* ================================== Afiliados ================================== */

export const affiliateNetworks = sqliteTable(
  'affiliate_networks',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    name: text('name').notNull(),
    website: text('website'),
    status: text('status', { enum: CONNECTION_STATUS }).notNull().default('NOT_CONFIGURED'),
    termsRef: text('terms_ref'),
    cookieDays: integer('cookie_days'),
    ...timestamps,
  },
  (t) => [uniqueIndex('affiliate_networks_name_uq').on(t.tenantId, t.name)],
);

export const affiliateProducts = sqliteTable('affiliate_products', {
  id: text('id').primaryKey(),
  tenantId: tenantRef(),
  networkId: text('network_id')
    .notNull()
    .references(() => affiliateNetworks.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  productUrl: text('product_url').notNull(),
  externalRef: text('external_ref'),
  commissionRateBps: integer('commission_rate_bps'),
  commissionSourceRef: text('commission_source_ref'),
  ...timestamps,
});

export const affiliateLinks = sqliteTable('affiliate_links', {
  id: text('id').primaryKey(),
  tenantId: tenantRef(),
  productId: text('product_id')
    .notNull()
    .references(() => affiliateProducts.id, { onDelete: 'cascade' }),
  networkId: text('network_id')
    .notNull()
    .references(() => affiliateNetworks.id, { onDelete: 'cascade' }),
  code: text('code').notNull().unique(),
  destinationUrl: text('destination_url').notNull(),
  campaign: text('campaign'),
  channel: text('channel', { enum: CHANNEL }),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  ...timestamps,
});

/** Clics: sin IP ni datos personales; solo host de referencia y país informado por Cloudflare. */
export const affiliateClicks = sqliteTable(
  'affiliate_clicks',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    linkId: text('link_id')
      .notNull()
      .references(() => affiliateLinks.id, { onDelete: 'cascade' }),
    referrerHost: text('referrer_host'),
    country: text('country'),
    clickedAt: ms('clicked_at').notNull(),
  },
  (t) => [index('affiliate_clicks_link_idx').on(t.linkId, t.clickedAt)],
);

export const affiliateConversions = sqliteTable(
  'affiliate_conversions',
  {
    id: text('id').primaryKey(),
    tenantId: tenantRef(),
    linkId: text('link_id')
      .notNull()
      .references(() => affiliateLinks.id, { onDelete: 'cascade' }),
    networkId: text('network_id')
      .notNull()
      .references(() => affiliateNetworks.id, { onDelete: 'cascade' }),
    externalRef: text('external_ref').notNull(),
    saleCents: integer('sale_cents').notNull(),
    currency: text('currency', { enum: CURRENCY }).notNull(),
    commissionCents: integer('commission_cents').notNull(),
    status: text('status', { enum: ['PENDING', 'APPROVED', 'REJECTED', 'PAID'] }).notNull(),
    source: text('source', { enum: ['MANUAL', 'NETWORK_REPORT'] }).notNull(),
    sourceRef: text('source_ref').notNull(),
    occurredAt: ms('occurred_at').notNull(),
    recordedAt: ms('recorded_at').notNull().default(epochMsDefault),
    updatedAt: timestamps.updatedAt,
  },
  (t) => [uniqueIndex('affiliate_conversions_ref_uq').on(t.tenantId, t.networkId, t.externalRef)],
);

export type ChannelConnectionRow = typeof channelConnections.$inferSelect;
export type ChannelListingRow = typeof channelListings.$inferSelect;
export type ChannelOrderRow = typeof channelOrders.$inferSelect;
export type WebhookEventRow = typeof webhookEvents.$inferSelect;
export type IntegrationLogRow = typeof integrationLogs.$inferSelect;
export type ChannelMessageRow = typeof channelMessages.$inferSelect;
export type AffiliateNetworkRow = typeof affiliateNetworks.$inferSelect;
export type AffiliateProductRow = typeof affiliateProducts.$inferSelect;
export type AffiliateLinkRow = typeof affiliateLinks.$inferSelect;
export type AffiliateConversionRow = typeof affiliateConversions.$inferSelect;

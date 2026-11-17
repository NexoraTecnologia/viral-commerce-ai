import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  assertCommercialActionAllowed,
  canSendFreeformMessage,
  CHANNEL_LIMITS,
  checkChannelPolicy,
  evaluatePublishGate,
  RATE_LIMITS,
} from '@vc/business-rules';
import {
  auditEvents,
  channelConnections,
  channelListings,
  channelMessages,
  channelOrders,
  discoveredProducts,
  generatedContents,
  integrationLogs,
  oauthStates,
  productImages,
  suppliers,
  webhookEvents,
  type ChannelConnectionRow,
  type ChannelListingRow,
  type ChannelMessageRow,
  type ChannelOrderRow,
  type Database,
} from '@vc/database';
import {
  answerMercadoLibreQuestion,
  createChannelAdapter,
  listMercadoLibreQuestions,
  sendWhatsAppMessage,
  type ExternalOrder,
} from '@vc/integrations';
import { pkceChallengeS256, randomToken, sha256Hex } from '@vc/security';
import {
  appError,
  err,
  newId,
  ok,
  type ChannelConnectionDto,
  type ChannelKind,
  type ChannelListingDto,
  type ChannelMessageDto,
  type ChannelOrderDto,
  type ConnectWithTokenRequest,
  type CreateConnectionRequest,
  type IntegrationLogDto,
  type ListingDraft,
  type PrepareListingRequest,
  type PrepareMessageRequest,
  type PublishGateResult,
  type Result,
  type WebhookEventDto,
} from '@vc/shared';
import { iso, isoOrNull, notFound } from '../../http';
import { findProduct, findSupplierProduct, getLatestInventory } from '../catalog/service';
import { analyzeDiscovered } from '../discovery/service';
import { evaluateForProduct } from '../profit/service';
import {
  adapterContext,
  adapterFor,
  consumeRate,
  decryptPkce,
  encryptPkce,
  loadTokens,
  logged,
  missingLiveSecrets,
  storeTokens,
  type ChannelRuntime,
} from './runtime';

const OAUTH_TTL_MS = 10 * 60_000;
export const OAUTH_CHANNELS = { mercadolibre: 'MERCADO_LIBRE', instagram: 'INSTAGRAM' } as const;
const SLUG_BY_CHANNEL: Partial<Record<ChannelKind, string>> = {
  MERCADO_LIBRE: 'mercadolibre',
  INSTAGRAM: 'instagram',
};

/* ================================== Conexiones ================================== */

const capabilitiesOf = (rt: ChannelRuntime, row: ChannelConnectionRow) =>
  createChannelAdapter(row.channel, row.mode, adapterContext(rt, row.channel, null)).capabilities;

export const toConnectionDto = (
  rt: ChannelRuntime,
  row: ChannelConnectionRow,
): ChannelConnectionDto => ({
  id: row.id,
  channel: row.channel,
  mode: row.mode,
  status: row.status,
  statusDetail: row.statusDetail,
  displayName: row.displayName,
  externalAccountId: row.externalAccountId,
  externalAccountName: row.externalAccountName,
  scopes: row.scopes,
  tokenExpiresAt: isoOrNull(row.tokenExpiresAt),
  lastCheckedAt: isoOrNull(row.lastCheckedAt),
  lastError: row.lastError,
  capabilities: capabilitiesOf(rt, row),
  createdAt: iso(row.createdAt),
});

export const findConnection = (db: Database, tenantId: string, id: string) =>
  db
    .select()
    .from(channelConnections)
    .where(and(eq(channelConnections.id, id), eq(channelConnections.tenantId, tenantId)))
    .get();

const reload = async (rt: ChannelRuntime, id: string) => {
  const row = await findConnection(rt.db, rt.tenantId, id);
  return row ? ok(toConnectionDto(rt, row)) : notFound('Conexión');
};

const setStatus = (
  rt: ChannelRuntime,
  id: string,
  patch: Partial<typeof channelConnections.$inferInsert>,
) =>
  rt.db
    .update(channelConnections)
    .set({ ...patch, updatedAt: rt.now })
    .where(and(eq(channelConnections.id, id), eq(channelConnections.tenantId, rt.tenantId)));

export const listConnections = async (rt: ChannelRuntime) =>
  (
    await rt.db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.tenantId, rt.tenantId))
      .orderBy(desc(channelConnections.createdAt))
  ).map((r) => toConnectionDto(rt, r));

/** Estado inicial honesto: LIVE nunca arranca CONNECTED salvo la tienda propia (local). */
export const createConnection = async (
  rt: ChannelRuntime,
  input: CreateConnectionRequest,
): Promise<Result<ChannelConnectionDto>> => {
  const id = newId();
  let status: ChannelConnectionRow['status'] = 'NOT_CONFIGURED';
  let detail: string;
  let externalAccountId: string | null = null;
  let externalAccountName: string | null = null;
  let scopes: string[] = [];
  if (input.mode === 'MOCK') {
    const mock = createChannelAdapter(
      input.channel,
      'MOCK',
      adapterContext(rt, input.channel, null),
    );
    const st = await mock.getConnectionStatus();
    const tokens = await mock.connect({ type: 'authorize', state: 'mock', redirectUri: 'mock://' });
    status = st.ok ? st.value.status : 'ERROR';
    detail = st.ok ? st.value.detail : st.error.message;
    externalAccountId = st.ok ? st.value.externalAccountId : null;
    externalAccountName = st.ok ? st.value.externalAccountName : null;
    scopes = tokens.ok && tokens.value.type === 'tokens' ? [...tokens.value.tokens.scopes] : [];
  } else if (input.channel === 'OWN_STORE') {
    status = 'CONNECTED';
    detail = 'Tienda propia servida por la API. Checkout: no configurado';
  } else if (input.channel === 'AFFILIATE') {
    detail = 'Sin conector de red: gestión local de enlaces y conversiones';
  } else {
    const missing = missingLiveSecrets(input.channel, rt.secrets);
    detail =
      missing.length > 0
        ? `Faltan secrets: ${missing.join(', ')}`
        : input.channel === 'WHATSAPP'
          ? 'Pendiente: cargar token del sistema e ID del número'
          : 'Pendiente: autorizar la cuenta (OAuth)';
  }
  await rt.db.insert(channelConnections).values({
    id,
    tenantId: rt.tenantId,
    channel: input.channel,
    mode: input.mode,
    status,
    statusDetail: detail,
    displayName: input.displayName,
    externalAccountId,
    externalAccountName,
    scopes,
    lastCheckedAt: rt.now,
    createdAt: rt.now,
    updatedAt: rt.now,
  });
  return reload(rt, id);
};

const requireLiveOAuth = async (rt: ChannelRuntime, id: string) => {
  const row = await findConnection(rt.db, rt.tenantId, id);
  if (!row) return notFound('Conexión');
  if (row.mode !== 'LIVE') return err(appError('CONFLICT', 'Las conexiones MOCK no usan OAuth'));
  if (row.status === 'DISABLED') return err(appError('CONFLICT', 'Conexión deshabilitada'));
  const slug = SLUG_BY_CHANNEL[row.channel];
  if (!slug) return err(appError('VALIDATION_ERROR', 'Este canal no se conecta por OAuth'));
  const missing = missingLiveSecrets(row.channel, rt.secrets);
  if (missing.length > 0) {
    return err(appError('INTEGRATION_NOT_CONFIGURED', `Faltan secrets: ${missing.join(', ')}`));
  }
  return ok({ row, slug });
};

const redirectUriFor = (rt: ChannelRuntime, slug: string) =>
  `${(rt.secrets.PUBLIC_API_URL ?? '').replace(/\/+$/, '')}/oauth/callback/${slug}`;

/** Paso 1 OAuth: state de un solo uso (se guarda su hash) + PKCE S256 para Mercado Libre. */
export const startOAuth = async (
  rt: ChannelRuntime,
  id: string,
): Promise<Result<{ authorizationUrl: string }>> => {
  const r = await requireLiveOAuth(rt, id);
  if (!r.ok) return r;
  const { row, slug } = r.value;
  const state = randomToken();
  const redirectUri = redirectUriFor(rt, slug);
  let codeChallenge: string | undefined;
  let codeVerifierEnc: string | null = null;
  if (row.channel === 'MERCADO_LIBRE') {
    const verifier = randomToken(48);
    codeChallenge = await pkceChallengeS256(verifier);
    codeVerifierEnc = await encryptPkce(rt, row.id, verifier);
  }
  const adapter = await adapterFor(rt, row);
  const res = await logged(rt, row, 'connect.authorize', () =>
    adapter.connect({
      type: 'authorize',
      state,
      redirectUri,
      ...(codeChallenge ? { codeChallenge } : {}),
    }),
  );
  if (!res.ok) return res;
  if (res.value.type !== 'redirect') return err(appError('INTERNAL_ERROR', 'Respuesta inesperada'));
  await rt.db.insert(oauthStates).values({
    id: newId(),
    tenantId: rt.tenantId,
    connectionId: row.id,
    stateHash: await sha256Hex(state),
    codeVerifierEnc,
    redirectUri,
    expiresAt: new Date(rt.now.getTime() + OAUTH_TTL_MS),
    createdAt: rt.now,
  });
  return ok({ authorizationUrl: res.value.authorizationUrl });
};

/**
 * Paso 2 OAuth (callback público). Valida el state (existe, no usado, no vencido),
 * lo consume de forma atómica, intercambia el code y cifra los tokens.
 */
export const completeOAuth = async (
  base: Omit<ChannelRuntime, 'tenantId'>,
  channel: ChannelKind,
  state: string,
  code: string,
): Promise<Result<ChannelConnectionDto>> => {
  const stateHash = await sha256Hex(state);
  const claimed = await base.db
    .update(oauthStates)
    .set({ usedAt: base.now })
    .where(and(eq(oauthStates.stateHash, stateHash), isNull(oauthStates.usedAt)))
    .returning();
  const st = claimed[0];
  if (!st) return err(appError('UNAUTHORIZED', 'state OAuth inválido o ya utilizado'));
  if (st.expiresAt.getTime() < base.now.getTime())
    return err(appError('UNAUTHORIZED', 'state OAuth vencido'));
  const rt: ChannelRuntime = { ...base, tenantId: st.tenantId };
  const row = await findConnection(rt.db, rt.tenantId, st.connectionId);
  if (!row || row.channel !== channel) return err(appError('UNAUTHORIZED', 'state OAuth inválido'));

  const codeVerifier = st.codeVerifierEnc
    ? await decryptPkce(rt.secrets, row.id, st.codeVerifierEnc)
    : null;
  const adapter = await adapterFor(rt, row);
  const res = await logged(rt, row, 'connect.exchange_code', () =>
    adapter.connect({
      type: 'exchange_code',
      code,
      redirectUri: st.redirectUri,
      ...(codeVerifier ? { codeVerifier } : {}),
    }),
  );
  if (!res.ok) {
    await setStatus(rt, row.id, { status: 'ERROR', statusDetail: res.error.message });
    return res;
  }
  if (res.value.type !== 'tokens') return err(appError('INTERNAL_ERROR', 'Respuesta inesperada'));
  const stored = await storeTokens(rt, row, res.value.tokens);
  if (!stored.ok) return stored;
  return checkConnection(rt, row.id);
};

/** WhatsApp: token del sistema + ID del número, validados contra la API antes de guardarse. */
export const connectWithToken = async (
  rt: ChannelRuntime,
  id: string,
  input: ConnectWithTokenRequest,
): Promise<Result<ChannelConnectionDto>> => {
  const row = await findConnection(rt.db, rt.tenantId, id);
  if (!row) return notFound('Conexión');
  if (row.channel !== 'WHATSAPP' || row.mode !== 'LIVE')
    return err(appError('VALIDATION_ERROR', 'Solo WhatsApp LIVE se conecta con token'));
  const missing = missingLiveSecrets(row.channel, rt.secrets);
  if (missing.length > 0)
    return err(appError('INTEGRATION_NOT_CONFIGURED', `Faltan secrets: ${missing.join(', ')}`));
  const adapter = await adapterFor(rt, row);
  const res = await logged(rt, row, 'connect.token', () =>
    adapter.connect({
      type: 'token',
      accessToken: input.accessToken,
      accountId: input.phoneNumberId,
    }),
  );
  if (!res.ok) {
    await setStatus(rt, row.id, { status: 'ERROR', statusDetail: res.error.message });
    return res;
  }
  if (res.value.type !== 'tokens') return err(appError('INTERNAL_ERROR', 'Respuesta inesperada'));
  const stored = await storeTokens(rt, row, res.value.tokens);
  if (!stored.ok) return stored;
  return checkConnection(rt, row.id);
};

/**
 * Verifica el estado REAL contra el canal. Si el token venció y el canal soporta
 * renovación, la intenta una vez antes de informar EXPIRED.
 */
export const checkConnection = async (
  rt: ChannelRuntime,
  id: string,
): Promise<Result<ChannelConnectionDto>> => {
  let row = await findConnection(rt.db, rt.tenantId, id);
  if (!row) return notFound('Conexión');
  if (row.status === 'DISABLED') return reload(rt, id);
  let adapter = await adapterFor(rt, row);
  let state = await logged(rt, row, 'getConnectionStatus', () => adapter.getConnectionStatus());
  if (
    state.ok &&
    state.value.status === 'EXPIRED' &&
    adapter.capabilities.connect.support === 'SUPPORTED'
  ) {
    const refreshed = await logged(rt, row, 'refreshTokens', () => adapter.refreshTokens());
    if (refreshed.ok) {
      await storeTokens(rt, row, refreshed.value);
      row = (await findConnection(rt.db, rt.tenantId, id)) ?? row;
      adapter = await adapterFor(rt, row);
      state = await logged(rt, row, 'getConnectionStatus', () => adapter.getConnectionStatus());
    }
  }
  if (!state.ok) {
    await setStatus(rt, id, {
      status: 'ERROR',
      statusDetail: state.error.message,
      lastCheckedAt: rt.now,
    });
    return reload(rt, id);
  }
  await setStatus(rt, id, {
    status: state.value.status,
    statusDetail: state.value.detail,
    externalAccountId: state.value.externalAccountId ?? row.externalAccountId,
    externalAccountName: state.value.externalAccountName,
    lastCheckedAt: rt.now,
    ...(state.value.status === 'CONNECTED' ? { lastError: null } : {}),
  });
  return reload(rt, id);
};

export const refreshConnection = async (
  rt: ChannelRuntime,
  id: string,
): Promise<Result<ChannelConnectionDto>> => {
  const row = await findConnection(rt.db, rt.tenantId, id);
  if (!row) return notFound('Conexión');
  const adapter = await adapterFor(rt, row);
  const res = await logged(rt, row, 'refreshTokens', () => adapter.refreshTokens());
  if (!res.ok) return res;
  const stored = await storeTokens(rt, row, res.value);
  if (!stored.ok) return stored;
  return checkConnection(rt, id);
};

/** Desconectar: borra los tokens locales (la revocación remota la hace el titular). */
export const disconnectConnection = async (
  rt: ChannelRuntime,
  id: string,
): Promise<Result<ChannelConnectionDto>> => {
  const row = await findConnection(rt.db, rt.tenantId, id);
  if (!row) return notFound('Conexión');
  const adapter = await adapterFor(rt, row);
  await logged(rt, row, 'disconnect', () => adapter.disconnect());
  await setStatus(rt, id, {
    status: 'NOT_CONFIGURED',
    statusDetail: 'Desconectada: tokens locales eliminados',
    accessTokenEnc: null,
    refreshTokenEnc: null,
    tokenExpiresAt: null,
    scopes: [],
  });
  return reload(rt, id);
};

export const setConnectionEnabled = async (
  rt: ChannelRuntime,
  id: string,
  enabled: boolean,
): Promise<Result<ChannelConnectionDto>> => {
  const row = await findConnection(rt.db, rt.tenantId, id);
  if (!row) return notFound('Conexión');
  if (!enabled) {
    await setStatus(rt, id, { status: 'DISABLED', statusDetail: 'Deshabilitada por el usuario' });
    return reload(rt, id);
  }
  await setStatus(rt, id, { status: 'NOT_CONFIGURED', statusDetail: 'Rehabilitada: verificando' });
  return checkConnection(rt, id);
};

const usableConnection = async (rt: ChannelRuntime, id: string) => {
  const row = await findConnection(rt.db, rt.tenantId, id);
  if (!row) return notFound('Conexión');
  if (row.status === 'DISABLED') return err(appError('CONFLICT', 'Conexión deshabilitada'));
  return ok(row);
};

export const getCatalog = async (rt: ChannelRuntime, id: string) => {
  const row = await usableConnection(rt, id);
  if (!row.ok) return row;
  const rate = await consumeRate(rt, row.value, 'api', RATE_LIMITS[row.value.channel]?.['api']);
  if (!rate.ok) return rate;
  const adapter = await adapterFor(rt, row.value, {
    storeCatalog: () => storeCatalogItems(rt, id),
  });
  return logged(rt, row.value, 'getCatalog', () => adapter.getCatalog());
};

const storeCatalogItems = async (rt: ChannelRuntime, connectionId: string) =>
  (
    await rt.db
      .select()
      .from(channelListings)
      .where(
        and(
          eq(channelListings.connectionId, connectionId),
          eq(channelListings.status, 'PUBLISHED'),
        ),
      )
  ).map((l) => ({
    externalId: l.externalId ?? l.id,
    title: l.draft.title,
    status: l.status,
    url: null,
  }));

/* ================================= Publicaciones ================================= */

const toListingDto = (l: ChannelListingRow, c: ChannelConnectionRow): ChannelListingDto => ({
  id: l.id,
  connectionId: l.connectionId,
  channel: c.channel,
  mode: c.mode,
  discoveredProductId: l.discoveredProductId,
  productId: l.productId,
  status: l.status,
  externalId: l.externalId,
  externalUrl: l.externalUrl,
  draft: l.draft,
  gate: l.gate,
  lastError: l.lastError,
  publishedAt: isoOrNull(l.publishedAt),
  createdAt: iso(l.createdAt),
  updatedAt: iso(l.updatedAt),
});

export const listListings = async (rt: ChannelRuntime): Promise<ChannelListingDto[]> => {
  const rows = await rt.db
    .select()
    .from(channelListings)
    .innerJoin(channelConnections, eq(channelListings.connectionId, channelConnections.id))
    .where(eq(channelListings.tenantId, rt.tenantId))
    .orderBy(desc(channelListings.updatedAt));
  return rows.map((r) => toListingDto(r.channel_listings, r.channel_connections));
};

const findListing = async (rt: ChannelRuntime, id: string) => {
  const r = await rt.db
    .select()
    .from(channelListings)
    .innerJoin(channelConnections, eq(channelListings.connectionId, channelConnections.id))
    .where(and(eq(channelListings.id, id), eq(channelListings.tenantId, rt.tenantId)))
    .get();
  return r ? { listing: r.channel_listings, connection: r.channel_connections } : null;
};

export const getListing = async (rt: ChannelRuntime, id: string) => {
  const r = await findListing(rt, id);
  return r ? ok(toListingDto(r.listing, r.connection)) : notFound('Publicación');
};

/**
 * Re-evalúa TODAS las condiciones de publicación con datos frescos. Se usa al
 * preparar y otra vez justo antes de publicar (los datos pueden haber cambiado).
 */
const evaluateGate = async (
  rt: ChannelRuntime,
  connection: ChannelConnectionRow,
  discoveredProductId: string | null,
  draft: ListingDraft,
  contentId: string | null,
): Promise<PublishGateResult> => {
  const dp = discoveredProductId
    ? await rt.db
        .select()
        .from(discoveredProducts)
        .where(
          and(
            eq(discoveredProducts.id, discoveredProductId),
            eq(discoveredProducts.tenantId, rt.tenantId),
          ),
        )
        .get()
    : undefined;
  const offer = dp?.supplierProductId
    ? await findSupplierProduct(rt.db, rt.tenantId, dp.supplierProductId)
    : undefined;
  const supplier = offer
    ? await rt.db.select().from(suppliers).where(eq(suppliers.id, offer.supplierId)).get()
    : undefined;
  const inventory = offer ? await getLatestInventory(rt.db, rt.tenantId, offer.id) : null;
  const evaluation =
    dp?.productId && offer
      ? await evaluateForProduct(rt.db, rt.tenantId, dp.productId, offer.id, rt.config, rt.now)
      : null;
  const analysis =
    dp && dp.status === 'CANDIDATE'
      ? await analyzeDiscovered(rt.db, rt.tenantId, dp.id, rt.config, rt.now)
      : null;
  const content = contentId
    ? await rt.db.select().from(generatedContents).where(eq(generatedContents.id, contentId)).get()
    : undefined;
  const adapter = createChannelAdapter(
    connection.channel,
    connection.mode,
    adapterContext(rt, connection.channel, null),
  );

  const riskBlockers: string[] = [];
  if (!dp) riskBlockers.push('Sin producto investigado');
  else if (dp.status !== 'CANDIDATE') riskBlockers.push(`Producto en estado ${dp.status}`);
  if (analysis && !analysis.ok) riskBlockers.push(analysis.error.message);
  if (analysis?.ok) riskBlockers.push(...analysis.value.risk.blockers);

  return evaluatePublishGate({
    supplier: supplier
      ? {
          status: supplier.status,
          directDispatch: supplier.directDispatch,
          dispatchLeadTimeDaysMax: supplier.dispatchLeadTimeDaysMax,
          deliveryTimeDaysMax: supplier.deliveryTimeDaysMax,
        }
      : null,
    stock: inventory
      ? {
          status: inventory.stockStatus,
          quantity: inventory.quantity,
          ageHours: (rt.now.getTime() - inventory.checkedAt.getTime()) / 3_600_000,
          maxAgeHours: rt.config.MAX_STOCK_AGE_HOURS,
        }
      : null,
    marginBps: evaluation?.ok ? (evaluation.value.viability.breakdown?.marginBps ?? null) : null,
    minMarginBps: rt.config.MIN_NET_MARGIN_BPS,
    policyIssues: checkChannelPolicy(connection.channel, draft, content?.compliance ?? null),
    riskPassed: Boolean(analysis?.ok && analysis.value.risk.passed),
    riskBlockers,
    connection: {
      mode: connection.mode,
      status: connection.status,
      scopes: connection.scopes,
      requiredScopes: adapter.requiredPublishScopes,
    },
    commercialActionsEnabled: rt.config.COMMERCIAL_ACTIONS_ENABLED,
    now: rt.now,
  });
};

/** Prepara una publicación con datos reales (producto, contenido, imágenes autorizadas). */
export const prepareListing = async (
  rt: ChannelRuntime,
  input: PrepareListingRequest,
): Promise<Result<ChannelListingDto>> => {
  const connection = await usableConnection(rt, input.connectionId);
  if (!connection.ok) return connection;
  const dp = await rt.db
    .select()
    .from(discoveredProducts)
    .where(
      and(
        eq(discoveredProducts.id, input.discoveredProductId),
        eq(discoveredProducts.tenantId, rt.tenantId),
      ),
    )
    .get();
  if (!dp) return notFound('Producto investigado');
  if (dp.status !== 'CANDIDATE')
    return err(appError('CONFLICT', 'Solo se preparan publicaciones de productos candidatos'));
  const product = dp.productId ? await findProduct(rt.db, rt.tenantId, dp.productId) : undefined;
  if (!product) return err(appError('CONFLICT', 'El candidato no tiene producto propio vinculado'));

  const content = input.contentId
    ? await rt.db
        .select()
        .from(generatedContents)
        .where(
          and(
            eq(generatedContents.id, input.contentId),
            eq(generatedContents.discoveredProductId, dp.id),
          ),
        )
        .get()
    : await rt.db
        .select()
        .from(generatedContents)
        .where(eq(generatedContents.discoveredProductId, dp.id))
        .orderBy(desc(generatedContents.version))
        .get();
  if (input.contentId && !content) return notFound('Contenido');

  // Imágenes: solo las que tienen autorización registrada.
  const images = (
    await rt.db.select().from(productImages).where(eq(productImages.discoveredProductId, dp.id))
  )
    .filter((i) => i.authorization !== 'NONE')
    .map((i) => i.url);

  const c = content?.content;
  const channel = connection.value.channel;
  const draft: ListingDraft = {
    title: (c?.seoTitle ?? product.title).slice(0, 200),
    description:
      (channel === 'MERCADO_LIBRE'
        ? c?.marketplaceDescription
        : channel === 'OWN_STORE'
          ? c?.storeDescription
          : c?.description) ??
      product.description ??
      '',
    priceCents: product.salePriceCents,
    currency: product.currency,
    quantity: input.quantity ?? 1,
    imageUrls: images,
    caption: channel === 'INSTAGRAM' ? (c?.instagram ?? null) : null,
    categoryId: input.categoryId ?? null,
    listingTypeId: input.listingTypeId ?? null,
    condition: input.condition ?? null,
  };

  const gate = await evaluateGate(rt, connection.value, dp.id, draft, content?.id ?? null);
  const id = newId();
  await rt.db.insert(channelListings).values({
    id,
    tenantId: rt.tenantId,
    connectionId: connection.value.id,
    discoveredProductId: dp.id,
    productId: product.id,
    contentId: content?.id ?? null,
    status: gate.allowed || gate.allowedInMock ? 'READY' : 'BLOCKED',
    draft,
    gate,
    idempotencyKey: `listing:${id}`,
    createdAt: rt.now,
    updatedAt: rt.now,
  });
  return getListing(rt, id);
};

/**
 * Publicación (manual o automática). Condiciones: gate completo. En MOCK se
 * simula si pasan las reglas de negocio; en LIVE además el Commercial Guard.
 */
export const publishListing = async (
  rt: ChannelRuntime,
  id: string,
  trigger: 'MANUAL' | 'AUTO',
): Promise<Result<ChannelListingDto>> => {
  const found = await findListing(rt, id);
  if (!found) return notFound('Publicación');
  const { listing, connection } = found;
  if (connection.status === 'DISABLED') return err(appError('CONFLICT', 'Conexión deshabilitada'));
  if (listing.status === 'PUBLISHED') return getListing(rt, id);

  const gate = await evaluateGate(
    rt,
    connection,
    listing.discoveredProductId,
    listing.draft,
    listing.contentId,
  );
  const permitted = connection.mode === 'MOCK' ? gate.allowedInMock : gate.allowed;
  if (!permitted) {
    await rt.db
      .update(channelListings)
      .set({ gate, status: 'BLOCKED', updatedAt: rt.now })
      .where(eq(channelListings.id, id));
    await rt.db.insert(integrationLogs).values({
      id: newId(),
      tenantId: rt.tenantId,
      connectionId: connection.id,
      channel: connection.channel,
      operation: `${connection.mode === 'MOCK' ? 'mock.' : ''}createListing`,
      outcome: 'BLOCKED',
      errorCode: 'PUBLISH_GATE',
      message: gate.checks
        .filter((x) => !x.passed)
        .map((x) => x.check)
        .join(', '),
      createdAt: rt.now,
    });
    return err(
      appError('CONFLICT', 'La publicación no cumple las condiciones', {
        failed: gate.checks.filter((x) => !x.passed),
      }),
    );
  }
  if (connection.mode === 'LIVE') {
    const guard = assertCommercialActionAllowed('publish_listing', {
      commercialActionsEnabled: rt.config.COMMERCIAL_ACTIONS_ENABLED,
    });
    if (!guard.ok) return guard;
  }
  const rate = await consumeRate(
    rt,
    connection,
    'publish',
    RATE_LIMITS[connection.channel]?.['publish'],
  );
  if (!rate.ok) return rate;

  const adapter = await adapterFor(rt, connection);
  const res = await logged(rt, connection, 'createListing', () =>
    adapter.createListing(listing.draft, listing.idempotencyKey),
  );
  if (!res.ok) {
    await rt.db
      .update(channelListings)
      .set({ gate, status: 'ERROR', lastError: res.error.message, updatedAt: rt.now })
      .where(eq(channelListings.id, id));
    return res;
  }
  await rt.db
    .update(channelListings)
    .set({
      gate,
      status: res.value.status === 'PAUSED' ? 'PAUSED' : 'PUBLISHED',
      externalId: res.value.externalId,
      externalUrl: res.value.externalUrl,
      lastError: null,
      publishedAt: rt.now,
      updatedAt: rt.now,
    })
    .where(eq(channelListings.id, id));
  await rt.db.insert(auditEvents).values({
    id: newId(),
    tenantId: rt.tenantId,
    action: 'channel.listing_published',
    entityType: 'channel_listing',
    entityId: id,
    metadata: { channel: connection.channel, mode: connection.mode, trigger },
    dryRun: connection.mode === 'MOCK',
    createdAt: rt.now,
  });
  return getListing(rt, id);
};

export const syncListing = async (rt: ChannelRuntime, id: string) => {
  const found = await findListing(rt, id);
  if (!found) return notFound('Publicación');
  const { listing, connection } = found;
  if (!listing.externalId) return err(appError('CONFLICT', 'La publicación no fue publicada'));
  if (connection.mode === 'LIVE') {
    const guard = assertCommercialActionAllowed('publish_listing', {
      commercialActionsEnabled: rt.config.COMMERCIAL_ACTIONS_ENABLED,
    });
    if (!guard.ok) return guard;
  }
  const adapter = await adapterFor(rt, connection);
  const externalId = listing.externalId;
  const res = await logged(rt, connection, 'updateListing', () =>
    adapter.updateListing(externalId, listing.draft),
  );
  if (!res.ok) return res;
  await rt.db
    .update(channelListings)
    .set({ updatedAt: rt.now, lastError: null })
    .where(eq(channelListings.id, id));
  return getListing(rt, id);
};

/** Pausar reduce exposición: no requiere el interruptor comercial en MOCK ni para borradores. */
export const pauseListing = async (rt: ChannelRuntime, id: string) => {
  const found = await findListing(rt, id);
  if (!found) return notFound('Publicación');
  const { listing, connection } = found;
  if (!listing.externalId) {
    await rt.db
      .update(channelListings)
      .set({ status: 'PAUSED', updatedAt: rt.now })
      .where(eq(channelListings.id, id));
    return getListing(rt, id);
  }
  const adapter = await adapterFor(rt, connection);
  const externalId = listing.externalId;
  const res = await logged(rt, connection, 'pauseListing', () => adapter.pauseListing(externalId));
  if (!res.ok) return res;
  await rt.db
    .update(channelListings)
    .set({ status: 'PAUSED', updatedAt: rt.now })
    .where(eq(channelListings.id, id));
  return getListing(rt, id);
};

/** Intenta publicar automáticamente las publicaciones READY; el gate decide cada una. */
export const autoPublishReady = async (rt: ChannelRuntime) => {
  const ready = await rt.db
    .select({ id: channelListings.id })
    .from(channelListings)
    .where(and(eq(channelListings.tenantId, rt.tenantId), eq(channelListings.status, 'READY')))
    .limit(50);
  let published = 0;
  let blocked = 0;
  for (const l of ready) {
    const r = await publishListing(rt, l.id, 'AUTO');
    if (r.ok) published++;
    else blocked++;
  }
  return { evaluated: ready.length, published, blocked };
};

/* =================================== Pedidos =================================== */

const toOrderDto = (o: ChannelOrderRow, c: ChannelConnectionRow): ChannelOrderDto => ({
  id: o.id,
  connectionId: o.connectionId,
  channel: c.channel,
  mode: c.mode,
  externalOrderId: o.externalOrderId,
  status: o.status,
  rawStatus: o.rawStatus,
  totalCents: o.totalCents,
  currency: o.currency,
  placedAt: isoOrNull(o.placedAt),
  syncedAt: iso(o.syncedAt),
});

export const upsertOrder = (rt: ChannelRuntime, connectionId: string, o: ExternalOrder) =>
  rt.db
    .insert(channelOrders)
    .values({
      id: newId(),
      tenantId: rt.tenantId,
      connectionId,
      externalOrderId: o.externalOrderId,
      status: o.status,
      rawStatus: o.rawStatus,
      totalCents: o.totalCents,
      currency: o.currency,
      placedAt: o.placedAt,
      syncedAt: rt.now,
    })
    .onConflictDoUpdate({
      target: [channelOrders.connectionId, channelOrders.externalOrderId],
      set: { status: o.status, rawStatus: o.rawStatus, totalCents: o.totalCents, syncedAt: rt.now },
    });

export const syncOrders = async (rt: ChannelRuntime, id: string) => {
  const row = await usableConnection(rt, id);
  if (!row.ok) return row;
  const rate = await consumeRate(rt, row.value, 'api', RATE_LIMITS[row.value.channel]?.['api']);
  if (!rate.ok) return rate;
  const adapter = await adapterFor(rt, row.value);
  const res = await logged(rt, row.value, 'getOrders', () =>
    adapter.getOrders({ limit: 50, offset: 0 }),
  );
  if (!res.ok) return res;
  for (const o of res.value) await upsertOrder(rt, id, o);
  return ok({ synced: res.value.length });
};

export const refreshOrderStatus = async (
  rt: ChannelRuntime,
  id: string,
  externalOrderId: string,
) => {
  const row = await usableConnection(rt, id);
  if (!row.ok) return row;
  const adapter = await adapterFor(rt, row.value);
  const res = await logged(rt, row.value, 'getOrderStatus', () =>
    adapter.getOrderStatus(externalOrderId),
  );
  if (!res.ok) return res;
  await upsertOrder(rt, id, res.value);
  return ok(res.value);
};

export const listOrders = async (rt: ChannelRuntime) =>
  (
    await rt.db
      .select()
      .from(channelOrders)
      .innerJoin(channelConnections, eq(channelOrders.connectionId, channelConnections.id))
      .where(eq(channelOrders.tenantId, rt.tenantId))
      .orderBy(desc(channelOrders.syncedAt))
      .limit(200)
  ).map((r) => toOrderDto(r.channel_orders, r.channel_connections));

/* ============================ Mensajes y atención ============================ */

const toMessageDto = (m: ChannelMessageRow): ChannelMessageDto => ({
  id: m.id,
  connectionId: m.connectionId,
  channel: m.channel,
  direction: m.direction,
  kind: m.kind,
  externalId: m.externalId,
  contactRef: m.contactRef,
  body: m.body,
  status: m.status,
  detail: m.detail,
  createdAt: iso(m.createdAt),
});

export const listMessages = async (rt: ChannelRuntime) =>
  (
    await rt.db
      .select()
      .from(channelMessages)
      .where(eq(channelMessages.tenantId, rt.tenantId))
      .orderBy(desc(channelMessages.createdAt))
      .limit(200)
  ).map(toMessageDto);

/** Prepara un mensaje (borrador). Enviarlo es otra acción, sujeta al Commercial Guard. */
export const prepareMessage = async (
  rt: ChannelRuntime,
  input: PrepareMessageRequest,
): Promise<Result<ChannelMessageDto>> => {
  const row = await usableConnection(rt, input.connectionId);
  if (!row.ok) return row;
  const channel = row.value.channel;
  if (channel !== 'WHATSAPP' && channel !== 'MERCADO_LIBRE')
    return err(
      appError('UNSUPPORTED_OPERATION', 'Mensajería disponible para WhatsApp y Mercado Libre'),
    );
  if (channel === 'MERCADO_LIBRE') {
    if (!input.text) return err(appError('VALIDATION_ERROR', 'La respuesta debe ser texto'));
    if (input.text.length > CHANNEL_LIMITS.MERCADO_LIBRE.answerMaxChars)
      return err(appError('VALIDATION_ERROR', 'Máximo 2000 caracteres'));
  }
  const body =
    input.text ??
    `[plantilla ${input.template?.name ?? ''}] ${(input.template?.parameters ?? []).join(' | ')}`;
  const id = newId();
  await rt.db.insert(channelMessages).values({
    id,
    tenantId: rt.tenantId,
    connectionId: row.value.id,
    channel,
    direction: 'OUTBOUND',
    kind: channel === 'MERCADO_LIBRE' ? 'ANSWER' : input.template ? 'TEMPLATE' : 'TEXT',
    contactRef: input.contactRef,
    body: input.text ?? body,
    status: 'DRAFT',
    detail: input.template ? JSON.stringify(input.template) : null,
    createdAt: rt.now,
    updatedAt: rt.now,
  });
  const m = await rt.db.select().from(channelMessages).where(eq(channelMessages.id, id)).get();
  return m ? ok(toMessageDto(m)) : notFound('Mensaje');
};

/**
 * Envío de un borrador. Contactar clientes es acción comercial: con el interruptor
 * apagado queda BLOCKED. En MOCK se simula sin red. WhatsApp: texto libre solo
 * dentro de la ventana de 24 h; fuera, solo plantillas aprobadas.
 */
export const sendMessage = async (
  rt: ChannelRuntime,
  id: string,
): Promise<Result<ChannelMessageDto>> => {
  const m = await rt.db
    .select()
    .from(channelMessages)
    .where(and(eq(channelMessages.id, id), eq(channelMessages.tenantId, rt.tenantId)))
    .get();
  if (!m) return notFound('Mensaje');
  if (m.direction !== 'OUTBOUND' || (m.status !== 'DRAFT' && m.status !== 'BLOCKED'))
    return err(appError('CONFLICT', 'Solo se envían borradores'));
  const row = await usableConnection(rt, m.connectionId);
  if (!row.ok) return row;
  const finish = async (
    status: ChannelMessageRow['status'],
    detail: string | null,
    externalId?: string,
  ) => {
    await rt.db
      .update(channelMessages)
      .set({ status, detail, ...(externalId ? { externalId } : {}), updatedAt: rt.now })
      .where(eq(channelMessages.id, id));
    const updated = await rt.db
      .select()
      .from(channelMessages)
      .where(eq(channelMessages.id, id))
      .get();
    return updated ? ok(toMessageDto(updated)) : notFound('Mensaje');
  };

  if (m.channel === 'WHATSAPP' && m.kind === 'TEXT') {
    const lastInbound = await rt.db
      .select({ at: channelMessages.createdAt })
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.connectionId, m.connectionId),
          eq(channelMessages.contactRef, m.contactRef),
          eq(channelMessages.direction, 'INBOUND'),
        ),
      )
      .orderBy(desc(channelMessages.createdAt))
      .get();
    if (!canSendFreeformMessage(lastInbound?.at ?? null, rt.now)) {
      return finish(
        'BLOCKED',
        'Fuera de la ventana de 24 h: solo se permiten plantillas aprobadas',
      );
    }
  }

  if (row.value.mode === 'MOCK') {
    await logged(rt, row.value, 'sendMessage', () => Promise.resolve(ok(null)));
    return finish('SENT', 'MOCK: envío simulado, no salió ningún mensaje');
  }
  const guard = assertCommercialActionAllowed('send_customer_message', {
    commercialActionsEnabled: rt.config.COMMERCIAL_ACTIONS_ENABLED,
  });
  if (!guard.ok) {
    await logged(rt, row.value, 'sendMessage', () => Promise.resolve(guard));
    return finish('BLOCKED', guard.error.message);
  }
  const rate = await consumeRate(rt, row.value, 'message', RATE_LIMITS[m.channel]?.['message']);
  if (!rate.ok) return finish('BLOCKED', rate.error.message);

  const ctx = adapterContext(rt, row.value.channel, await loadTokens(row.value, rt.secrets));
  if (m.channel === 'MERCADO_LIBRE') {
    const res = await logged(rt, row.value, 'answerQuestion', () =>
      answerMercadoLibreQuestion(ctx, m.contactRef, m.body),
    );
    return res.ok ? finish('SENT', null) : finish('FAILED', res.error.message);
  }
  const template =
    m.kind === 'TEMPLATE' && m.detail
      ? (JSON.parse(m.detail) as { name: string; languageCode: string; parameters: string[] })
      : null;
  const res = await logged(rt, row.value, 'sendMessage', () =>
    sendWhatsAppMessage(
      ctx,
      template
        ? { kind: 'template', to: m.contactRef, ...template }
        : { kind: 'text', to: m.contactRef, body: m.body },
    ),
  );
  return res.ok ? finish('SENT', null, res.value.wamid) : finish('FAILED', res.error.message);
};

/** Mercado Libre: trae preguntas y las guarda como mensajes entrantes (idempotente). */
export const syncQuestions = async (rt: ChannelRuntime, id: string) => {
  const row = await usableConnection(rt, id);
  if (!row.ok) return row;
  if (row.value.channel !== 'MERCADO_LIBRE')
    return err(appError('UNSUPPORTED_OPERATION', 'Preguntas: solo Mercado Libre'));
  if (row.value.mode === 'MOCK') return ok({ synced: 0, note: 'MOCK: sin preguntas reales' });
  const ctx = adapterContext(rt, 'MERCADO_LIBRE', await loadTokens(row.value, rt.secrets));
  const res = await logged(rt, row.value, 'listQuestions', () => listMercadoLibreQuestions(ctx));
  if (!res.ok) return res;
  for (const q of res.value) {
    await rt.db
      .insert(channelMessages)
      .values({
        id: newId(),
        tenantId: rt.tenantId,
        connectionId: id,
        channel: 'MERCADO_LIBRE',
        direction: 'INBOUND',
        kind: 'QUESTION',
        externalId: q.id,
        contactRef: q.id,
        body: q.text,
        status: 'RECEIVED',
        detail: q.item_id ? `Ítem ${q.item_id} · ${q.status}` : q.status,
        createdAt: q.date_created ? new Date(q.date_created) : rt.now,
        updatedAt: rt.now,
      })
      .onConflictDoNothing();
  }
  return ok({ synced: res.value.length });
};

/* ============================== Logs y webhooks ============================== */

export const listLogs = async (rt: ChannelRuntime): Promise<IntegrationLogDto[]> =>
  (
    await rt.db
      .select()
      .from(integrationLogs)
      .where(eq(integrationLogs.tenantId, rt.tenantId))
      .orderBy(desc(integrationLogs.createdAt))
      .limit(200)
  ).map((l) => ({
    id: l.id,
    connectionId: l.connectionId,
    channel: l.channel,
    operation: l.operation,
    outcome: l.outcome,
    errorCode: l.errorCode,
    message: l.message,
    httpStatus: l.httpStatus,
    createdAt: iso(l.createdAt),
  }));

export const listWebhookEvents = async (rt: ChannelRuntime): Promise<WebhookEventDto[]> =>
  (
    await rt.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.tenantId, rt.tenantId))
      .orderBy(desc(webhookEvents.receivedAt))
      .limit(200)
  ).map((w) => ({
    id: w.id,
    channel: w.channel,
    connectionId: w.connectionId,
    topic: w.topic,
    resource: w.resource,
    status: w.status,
    detail: w.detail,
    receivedAt: iso(w.receivedAt),
    processedAt: isoOrNull(w.processedAt),
  }));

import { and, eq } from 'drizzle-orm';
import { consumeRateLimit, type RateLimitPolicy } from '@vc/business-rules';
import {
  channelConnections,
  integrationLogs,
  rateLimitWindows,
  type ChannelConnectionRow,
  type Database,
} from '@vc/database';
import {
  createChannelAdapter,
  type AdapterContext,
  type AdapterOptions,
  type AppCredentials,
  type ChannelAdapter,
  type TokenSet,
} from '@vc/integrations';
import {
  decryptSecret,
  encryptSecret,
  importTokenKey,
  redact,
  verifyMetaSignature,
} from '@vc/security';
import {
  appError,
  err,
  newId,
  type ApiConfig,
  type ChannelKind,
  type IntegrationOutcome,
  type Result,
} from '@vc/shared';
import type { ChannelSecrets } from '../../env';

/** Todo lo que necesita una operación de canal. `fetch` es inyectable para tests. */
export interface ChannelRuntime {
  readonly db: Database;
  readonly tenantId: string;
  readonly config: ApiConfig;
  readonly secrets: ChannelSecrets;
  readonly now: Date;
  readonly fetch?: typeof fetch;
}

export const credentialsFor = (channel: ChannelKind, s: ChannelSecrets): AppCredentials => {
  switch (channel) {
    case 'MERCADO_LIBRE':
      return { clientId: s.ML_APP_ID, clientSecret: s.ML_CLIENT_SECRET };
    case 'INSTAGRAM':
      return {
        clientId: s.INSTAGRAM_APP_ID,
        clientSecret: s.INSTAGRAM_APP_SECRET,
        webhookSecret: s.INSTAGRAM_APP_SECRET,
        webhookVerifyToken: s.META_WEBHOOK_VERIFY_TOKEN,
      };
    case 'WHATSAPP':
      return {
        webhookSecret: s.META_APP_SECRET,
        webhookVerifyToken: s.META_WEBHOOK_VERIFY_TOKEN,
      };
    default:
      return {};
  }
};

/** Secrets que faltan para operar un canal en modo LIVE (vacío = configurable). */
export const missingLiveSecrets = (channel: ChannelKind, s: ChannelSecrets): string[] => {
  const need: [string, string | undefined][] = [];
  if (channel === 'MERCADO_LIBRE' || channel === 'INSTAGRAM' || channel === 'WHATSAPP') {
    need.push(['TOKEN_ENCRYPTION_KEY', s.TOKEN_ENCRYPTION_KEY]);
  }
  if (channel === 'MERCADO_LIBRE') {
    need.push(['ML_APP_ID', s.ML_APP_ID], ['ML_CLIENT_SECRET', s.ML_CLIENT_SECRET]);
    need.push(['PUBLIC_API_URL', s.PUBLIC_API_URL]);
  }
  if (channel === 'INSTAGRAM') {
    need.push(['INSTAGRAM_APP_ID', s.INSTAGRAM_APP_ID]);
    need.push(['INSTAGRAM_APP_SECRET', s.INSTAGRAM_APP_SECRET]);
    need.push(['PUBLIC_API_URL', s.PUBLIC_API_URL]);
  }
  return need.filter(([, v]) => !v).map(([k]) => k);
};

const aad = (connectionId: string, kind: 'access' | 'refresh' | 'pkce') =>
  `${connectionId}:${kind}`;

export const tokenKey = (s: ChannelSecrets) => importTokenKey(s.TOKEN_ENCRYPTION_KEY);

export const loadTokens = async (
  row: ChannelConnectionRow,
  secrets: ChannelSecrets,
): Promise<TokenSet | null> => {
  if (!row.accessTokenEnc) return null;
  const key = await tokenKey(secrets);
  if (!key) return null;
  const access = await decryptSecret(key, row.accessTokenEnc, aad(row.id, 'access'));
  if (access === null) return null;
  const refresh = row.refreshTokenEnc
    ? await decryptSecret(key, row.refreshTokenEnc, aad(row.id, 'refresh'))
    : null;
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: row.tokenExpiresAt,
    scopes: row.scopes,
    externalAccountId: row.externalAccountId,
  };
};

/** Cifra y guarda tokens. Los tokens MOCK no se guardan (no tienen valor). */
export const storeTokens = async (
  rt: ChannelRuntime,
  row: ChannelConnectionRow,
  tokens: TokenSet,
): Promise<Result<void>> => {
  const key = await tokenKey(rt.secrets);
  if (!key) return err(appError('INTEGRATION_NOT_CONFIGURED', 'Falta TOKEN_ENCRYPTION_KEY'));
  await rt.db
    .update(channelConnections)
    .set({
      accessTokenEnc: await encryptSecret(key, tokens.accessToken, aad(row.id, 'access')),
      refreshTokenEnc: tokens.refreshToken
        ? await encryptSecret(key, tokens.refreshToken, aad(row.id, 'refresh'))
        : null,
      tokenExpiresAt: tokens.expiresAt,
      scopes: [...tokens.scopes],
      externalAccountId: tokens.externalAccountId,
      updatedAt: rt.now,
    })
    .where(eq(channelConnections.id, row.id));
  return { ok: true, value: undefined };
};

export const encryptPkce = async (rt: ChannelRuntime, connectionId: string, verifier: string) => {
  const key = await tokenKey(rt.secrets);
  return key ? encryptSecret(key, verifier, aad(connectionId, 'pkce')) : null;
};
export const decryptPkce = async (
  secrets: ChannelSecrets,
  connectionId: string,
  stored: string,
) => {
  const key = await tokenKey(secrets);
  return key ? decryptSecret(key, stored, aad(connectionId, 'pkce')) : null;
};

export const adapterContext = (
  rt: ChannelRuntime,
  channel: ChannelKind,
  tokens: TokenSet | null,
): AdapterContext => ({
  fetch: rt.fetch ?? ((input, init) => fetch(input, init)),
  now: () => rt.now,
  credentials: credentialsFor(channel, rt.secrets),
  tokens,
  verifySignature: verifyMetaSignature,
  allowWrites: rt.config.COMMERCIAL_ACTIONS_ENABLED,
});

export const adapterFor = async (
  rt: ChannelRuntime,
  row: ChannelConnectionRow,
  options: AdapterOptions = {},
): Promise<ChannelAdapter> => {
  const tokens = row.mode === 'LIVE' ? await loadTokens(row, rt.secrets) : null;
  return createChannelAdapter(
    row.channel,
    row.mode,
    adapterContext(rt, row.channel, tokens),
    options,
  );
};

/* ---------------------------- Registro de operaciones ---------------------------- */

const outcomeOf = (code: string): IntegrationOutcome =>
  code === 'UNSUPPORTED_OPERATION'
    ? 'UNSUPPORTED'
    : code === 'COMMERCIAL_ACTIONS_DISABLED' || code === 'RATE_LIMITED'
      ? 'BLOCKED'
      : 'ERROR';

/** Ejecuta una operación del adaptador y la registra (resultado, código, duración). */
export const logged = async <T>(
  rt: ChannelRuntime,
  row: ChannelConnectionRow,
  operation: string,
  fn: () => Promise<Result<T>>,
): Promise<Result<T>> => {
  const started = Date.now();
  const result = await fn();
  const details = result.ok
    ? undefined
    : (result.error.details as { httpStatus?: number } | undefined);
  await rt.db.insert(integrationLogs).values({
    id: newId(),
    tenantId: rt.tenantId,
    connectionId: row.id,
    channel: row.channel,
    operation: row.mode === 'MOCK' ? `mock.${operation}` : operation,
    outcome: result.ok ? 'OK' : outcomeOf(result.error.code),
    errorCode: result.ok ? null : result.error.code,
    message: result.ok ? null : String(redact(result.error.message)).slice(0, 500),
    httpStatus: typeof details?.httpStatus === 'number' ? details.httpStatus : null,
    durationMs: Date.now() - started,
    createdAt: rt.now,
  });
  if (!result.ok && row.mode === 'LIVE' && result.error.code !== 'UNSUPPORTED_OPERATION') {
    // Credencial rechazada (401/403): se SUSPENDE la integración hasta reconectar.
    const suspended = result.error.code === 'UNAUTHORIZED';
    await rt.db
      .update(channelConnections)
      .set({
        lastError: result.error.message.slice(0, 500),
        ...(suspended
          ? {
              status: 'EXPIRED' as const,
              statusDetail:
                'El canal rechazó la credencial: integración suspendida hasta reconectar',
            }
          : {}),
        updatedAt: rt.now,
      })
      .where(eq(channelConnections.id, row.id));
  }
  return result;
};

/* --------------------------------- Rate limiting --------------------------------- */

/** Consume una unidad de la ventana (D1). Las conexiones MOCK no consumen cupo real. */
export const consumeRate = async (
  rt: ChannelRuntime,
  row: ChannelConnectionRow,
  bucket: string,
  policy: RateLimitPolicy | undefined,
): Promise<Result<{ remaining: number | null }>> => {
  if (!policy || row.mode === 'MOCK') return { ok: true, value: { remaining: null } };
  const key = `${row.id}:${bucket}`;
  const current = await rt.db
    .select()
    .from(rateLimitWindows)
    .where(and(eq(rateLimitWindows.key, key), eq(rateLimitWindows.tenantId, rt.tenantId)))
    .get();
  const decision = consumeRateLimit(
    current ? { windowStart: current.windowStart, count: current.count } : null,
    policy,
    rt.now.getTime(),
  );
  if (!decision.allowed) {
    return err(
      appError('RATE_LIMITED', `Límite de ${policy.limit} operaciones alcanzado para ${bucket}`, {
        retryAfterMs: decision.retryAfterMs,
      }),
    );
  }
  await rt.db
    .insert(rateLimitWindows)
    .values({ key, tenantId: rt.tenantId, ...decision.next })
    .onConflictDoUpdate({ target: rateLimitWindows.key, set: { ...decision.next } });
  return { ok: true, value: { remaining: decision.remaining } };
};

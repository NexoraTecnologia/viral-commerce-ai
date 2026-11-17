import type {
  ChannelCapabilities,
  ChannelKind,
  ConnectionMode,
  ConnectionStatus,
  ListingDraft,
  OrderStatus,
  Result,
} from '@vc/shared';

/**
 * Contrato común de los adaptadores de canal. Cada adaptador declara sus
 * `capabilities` según la API OFICIAL: lo que la API no ofrece responde
 * `UNSUPPORTED_OPERATION` y nunca se simula en modo LIVE.
 */

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
  readonly scopes: readonly string[];
  readonly externalAccountId: string | null;
}

export interface ConnectionState {
  readonly status: ConnectionStatus;
  readonly detail: string;
  readonly externalAccountId: string | null;
  readonly externalAccountName: string | null;
  readonly expiresAt: Date | null;
}

export type ConnectRequest =
  /** Paso 1 OAuth: arma la URL de autorización. */
  | {
      readonly type: 'authorize';
      readonly state: string;
      readonly redirectUri: string;
      readonly codeChallenge?: string;
    }
  /** Paso 2 OAuth: intercambia el code por tokens (server side). */
  | {
      readonly type: 'exchange_code';
      readonly code: string;
      readonly redirectUri: string;
      readonly codeVerifier?: string;
    }
  /** Token emitido por el propio negocio (p. ej. usuario del sistema de WhatsApp). */
  | {
      readonly type: 'token';
      readonly accessToken: string;
      readonly accountId: string;
    };

export type ConnectResult =
  | { readonly type: 'redirect'; readonly authorizationUrl: string }
  | { readonly type: 'tokens'; readonly tokens: TokenSet };

export interface CatalogItem {
  readonly externalId: string;
  readonly title: string | null;
  readonly status: string | null;
  readonly url: string | null;
}

export interface ListingRef {
  readonly externalId: string;
  readonly externalUrl: string | null;
  readonly status: 'PUBLISHED' | 'PAUSED' | 'PENDING';
}

export interface ExternalOrder {
  readonly externalOrderId: string;
  readonly status: OrderStatus;
  readonly rawStatus: string;
  readonly totalCents: number | null;
  readonly currency: string | null;
  readonly placedAt: Date | null;
}

export interface OrdersQuery {
  readonly limit: number;
  readonly offset: number;
}

export interface WebhookRequest {
  readonly method: 'GET' | 'POST';
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly query: Readonly<Record<string, string | undefined>>;
}

export interface NormalizedWebhookEvent {
  /** Clave de idempotencia estable entre reintentos del canal. */
  readonly dedupeKey: string;
  readonly topic: string;
  readonly resource: string | null;
  /** Cuenta del canal a la que pertenece (para mapear al tenant). */
  readonly externalAccountId: string | null;
  readonly payload: Record<string, unknown>;
}

export type WebhookOutcome =
  /** Verificación de suscripción (GET de Meta): responder el challenge en texto. */
  | { readonly type: 'challenge'; readonly body: string }
  | { readonly type: 'events'; readonly events: readonly NormalizedWebhookEvent[] }
  | { readonly type: 'rejected'; readonly reason: string };

export interface ChannelAdapter {
  readonly channel: ChannelKind;
  readonly mode: ConnectionMode;
  readonly capabilities: ChannelCapabilities;
  /** Permisos que exige la publicación en este canal. */
  readonly requiredPublishScopes: readonly string[];

  connect(request: ConnectRequest): Promise<Result<ConnectResult>>;
  /** Revoca/olvida la conexión. El borrado local de tokens lo hace quien llama. */
  disconnect(): Promise<Result<{ remoteRevoked: boolean }>>;
  getConnectionStatus(): Promise<Result<ConnectionState>>;
  /** Renovación de tokens cuando la API la soporta; si no, UNSUPPORTED_OPERATION. */
  refreshTokens(): Promise<Result<TokenSet>>;
  getCatalog(): Promise<Result<readonly CatalogItem[]>>;
  createListing(draft: ListingDraft, idempotencyKey: string): Promise<Result<ListingRef>>;
  updateListing(externalId: string, draft: ListingDraft): Promise<Result<ListingRef>>;
  pauseListing(externalId: string): Promise<Result<ListingRef>>;
  getOrders(query: OrdersQuery): Promise<Result<readonly ExternalOrder[]>>;
  getOrderStatus(externalOrderId: string): Promise<Result<ExternalOrder>>;
  handleWebhook(request: WebhookRequest): Promise<Result<WebhookOutcome>>;
}

/** Credenciales de la APP (no del usuario). Vienen de secrets del Worker. */
export interface AppCredentials {
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
  /** Meta: App Secret para X-Hub-Signature-256; ML: no aplica. */
  readonly webhookSecret?: string | undefined;
  /** Meta: verify token elegido por nosotros para la suscripción GET. */
  readonly webhookVerifyToken?: string | undefined;
}

/** Firma HMAC inyectada (vive en @vc/security; integraciones no depende de él). */
export type SignatureVerifier = (
  secret: string | undefined,
  rawBody: string,
  header: string | undefined,
) => Promise<boolean>;

export interface AdapterContext {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly credentials: AppCredentials;
  /** Tokens del usuario ya descifrados, o null si no hay conexión. */
  readonly tokens: TokenSet | null;
  readonly verifySignature: SignatureVerifier;
  /**
   * Defensa en profundidad: aunque la capa de servicio ya aplica el Commercial
   * Guard, un adaptador LIVE rechaza escrituras si esto es false.
   */
  readonly allowWrites: boolean;
}

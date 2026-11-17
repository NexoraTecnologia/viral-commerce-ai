import type {
  ChannelKind,
  Compliance,
  ConnectionMode,
  ConnectionStatus,
  ListingDraft,
  PublishCheck,
  PublishGateResult,
} from '@vc/shared';

/* ============================ Políticas por canal ============================ */

/**
 * Límites documentados oficialmente (ver docs/CHANNELS.md con las fuentes).
 * Solo se codifican reglas verificadas; lo demás lo valida la API del canal.
 */
export const CHANNEL_LIMITS = {
  INSTAGRAM: { captionMaxChars: 2200, maxHashtags: 30, maxMentions: 20, maxCarouselItems: 20 },
  MERCADO_LIBRE: { answerMaxChars: 2000 },
  WHATSAPP: { customerServiceWindowHours: 24 },
} as const;

export interface PolicyIssue {
  readonly code: string;
  readonly message: string;
}

const JPEG_URL = /\.jpe?g(\?|#|$)/i;

/**
 * Valida un borrador contra las políticas conocidas del canal y el compliance del
 * contenido. No reemplaza la validación del propio canal: la complementa.
 */
export const checkChannelPolicy = (
  channel: ChannelKind,
  draft: ListingDraft,
  compliance: Compliance | null,
): readonly PolicyIssue[] => {
  const issues: PolicyIssue[] = [];
  if (compliance && !compliance.ok) {
    issues.push({
      code: 'CONTENT_COMPLIANCE',
      message: `El contenido tiene ${compliance.violations.length} término(s) a revisar`,
    });
  }
  if (draft.title.trim().length === 0)
    issues.push({ code: 'TITLE_REQUIRED', message: 'Falta título' });

  switch (channel) {
    case 'MERCADO_LIBRE':
      if (draft.priceCents <= 0) issues.push({ code: 'PRICE', message: 'Precio inválido' });
      if (draft.currency !== 'ARS')
        issues.push({ code: 'CURRENCY', message: 'Mercado Libre Argentina publica en ARS' });
      if (!draft.categoryId)
        issues.push({ code: 'CATEGORY_REQUIRED', message: 'Falta la categoría de Mercado Libre' });
      if (!draft.listingTypeId)
        issues.push({ code: 'LISTING_TYPE_REQUIRED', message: 'Falta el tipo de publicación' });
      if (!draft.condition)
        issues.push({ code: 'CONDITION_REQUIRED', message: 'Falta la condición (nuevo/usado)' });
      if (draft.quantity < 1)
        issues.push({ code: 'QUANTITY', message: 'Se requiere al menos 1 unidad disponible' });
      if (draft.imageUrls.length === 0)
        issues.push({ code: 'IMAGE_REQUIRED', message: 'Falta al menos una imagen autorizada' });
      break;
    case 'INSTAGRAM': {
      const caption = draft.caption ?? '';
      const L = CHANNEL_LIMITS.INSTAGRAM;
      if (draft.imageUrls.length === 0)
        issues.push({ code: 'IMAGE_REQUIRED', message: 'Instagram requiere una imagen' });
      if (draft.imageUrls.length > L.maxCarouselItems)
        issues.push({ code: 'TOO_MANY_IMAGES', message: `Máximo ${L.maxCarouselItems} imágenes` });
      if (draft.imageUrls.some((u) => !JPEG_URL.test(u)))
        issues.push({
          code: 'JPEG_ONLY',
          message: 'La API de Instagram solo acepta imágenes JPEG en URL pública',
        });
      if (caption.length > L.captionMaxChars)
        issues.push({ code: 'CAPTION_LENGTH', message: `Máximo ${L.captionMaxChars} caracteres` });
      if ((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > L.maxHashtags)
        issues.push({ code: 'HASHTAGS', message: `Máximo ${L.maxHashtags} hashtags` });
      if ((caption.match(/@[\w.]+/g) ?? []).length > L.maxMentions)
        issues.push({ code: 'MENTIONS', message: `Máximo ${L.maxMentions} menciones` });
      break;
    }
    case 'OWN_STORE':
      if (draft.priceCents <= 0) issues.push({ code: 'PRICE', message: 'Precio inválido' });
      break;
    case 'WHATSAPP':
      issues.push({
        code: 'CHANNEL_HAS_NO_LISTINGS',
        message: 'WhatsApp Cloud API no publica productos: se usa para mensajes y atención',
      });
      break;
    case 'AFFILIATE':
      issues.push({
        code: 'CHANNEL_HAS_NO_LISTINGS',
        message: 'Afiliados se gestiona con enlaces de seguimiento, no con publicaciones',
      });
      break;
  }
  return issues;
};

/* ============================ Publicación automática ============================ */

export interface PublishGateInput {
  readonly supplier: {
    readonly status: string;
    readonly directDispatch: boolean;
    readonly dispatchLeadTimeDaysMax: number | null;
    readonly deliveryTimeDaysMax: number | null;
  } | null;
  readonly stock: {
    readonly status: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';
    readonly quantity: number | null;
    readonly ageHours: number;
    readonly maxAgeHours: number;
  } | null;
  readonly marginBps: number | null;
  readonly minMarginBps: number;
  readonly policyIssues: readonly PolicyIssue[];
  readonly riskPassed: boolean;
  readonly riskBlockers: readonly string[];
  readonly connection: {
    readonly mode: ConnectionMode;
    readonly status: ConnectionStatus;
    readonly scopes: readonly string[];
    readonly requiredScopes: readonly string[];
  };
  readonly commercialActionsEnabled: boolean;
  readonly now: Date;
}

/**
 * Publicación automática: TODAS las condiciones deben cumplirse. El puntaje del
 * producto no participa. Una conexión MOCK puede simular la publicación si se
 * cumplen las condiciones de negocio, pero nunca habilita una publicación real.
 */
export const evaluatePublishGate = (input: PublishGateInput): PublishGateResult => {
  const checks: { check: PublishCheck; passed: boolean; detail: string }[] = [];
  const add = (check: PublishCheck, passed: boolean, detail: string) =>
    checks.push({ check, passed, detail });

  const s = input.supplier;
  add(
    'SUPPLIER_VERIFIED',
    s?.status === 'VERIFIED',
    s ? `Proveedor en estado ${s.status}` : 'Sin proveedor vinculado',
  );

  const st = input.stock;
  const stockOk =
    st !== null &&
    (st.status === 'IN_STOCK' || st.status === 'LOW_STOCK') &&
    (st.quantity === null || st.quantity > 0) &&
    st.ageHours <= st.maxAgeHours;
  add(
    'STOCK_VERIFIABLE',
    stockOk,
    st
      ? `Stock ${st.status}, control de hace ${Math.round(st.ageHours)} h (máx. ${st.maxAgeHours} h)`
      : 'Sin control de stock registrado',
  );

  add(
    'MIN_MARGIN',
    input.marginBps !== null && input.marginBps >= input.minMarginBps,
    input.marginBps === null
      ? 'Margen no calculable con los datos registrados'
      : `Margen ${(input.marginBps / 100).toFixed(2)} % (mínimo ${(input.minMarginBps / 100).toFixed(2)} %)`,
  );

  const logisticsOk =
    s !== null &&
    s.directDispatch &&
    s.dispatchLeadTimeDaysMax !== null &&
    s.deliveryTimeDaysMax !== null;
  add(
    'LOGISTICS_CAPACITY',
    logisticsOk,
    logisticsOk
      ? `Despacho directo, entrega en hasta ${s.deliveryTimeDaysMax} días`
      : 'Falta despacho directo o plazos de despacho/entrega del proveedor',
  );

  add(
    'CHANNEL_POLICY',
    input.policyIssues.length === 0,
    input.policyIssues.length === 0
      ? 'Cumple las políticas conocidas del canal'
      : input.policyIssues.map((i) => i.message).join('; '),
  );

  add(
    'RISK_GUARDIAN',
    input.riskPassed,
    input.riskPassed ? 'Risk Guardian aprueba' : `Bloqueos: ${input.riskBlockers.join(', ')}`,
  );

  const c = input.connection;
  const missingScopes = c.requiredScopes.filter((x) => !c.scopes.includes(x));
  const integrationOk = c.mode === 'LIVE' && c.status === 'CONNECTED' && missingScopes.length === 0;
  add(
    'INTEGRATION_AUTHORIZED',
    integrationOk,
    c.mode === 'MOCK'
      ? 'Conexión MOCK: solo simulación'
      : c.status !== 'CONNECTED'
        ? `Conexión en estado ${c.status}`
        : missingScopes.length > 0
          ? `Faltan permisos: ${missingScopes.join(', ')}`
          : 'Integración conectada y autorizada',
  );

  add(
    'COMMERCIAL_ACTIONS_ENABLED',
    input.commercialActionsEnabled,
    input.commercialActionsEnabled
      ? 'Acciones comerciales habilitadas'
      : 'COMMERCIAL_ACTIONS_ENABLED=false: modo simulación',
  );

  const business = checks.filter(
    (x) => x.check !== 'INTEGRATION_AUTHORIZED' && x.check !== 'COMMERCIAL_ACTIONS_ENABLED',
  );
  return {
    allowed: checks.every((x) => x.passed),
    allowedInMock: c.mode === 'MOCK' && business.every((x) => x.passed),
    checks,
    evaluatedAt: input.now.toISOString(),
  };
};

/* ================================ Rate limiting ================================ */

export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * Políticas por operación. Instagram: se usa el valor MÁS CONSERVADOR que publica
 * la documentación oficial (la misma página menciona 50 y 100 posts / 24 h).
 * WhatsApp: nivel inicial de 250 destinatarios únicos / 24 h fuera de ventana.
 * Mercado Libre no publica un número: se usa un límite propio prudente y se
 * respeta el 429 (`local_rate_limited`) que devuelve la API.
 */
export const RATE_LIMITS: Partial<Record<ChannelKind, Record<string, RateLimitPolicy>>> = {
  INSTAGRAM: { publish: { limit: 50, windowMs: 24 * 3_600_000 } },
  WHATSAPP: { message: { limit: 250, windowMs: 24 * 3_600_000 } },
  MERCADO_LIBRE: { api: { limit: 600, windowMs: 60_000 } },
};

export interface RateWindow {
  readonly windowStart: number;
  readonly count: number;
}

export type RateDecision =
  | { readonly allowed: true; readonly next: RateWindow; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterMs: number };

/** Ventana fija: pura y determinística; el estado se persiste afuera (D1). */
export const consumeRateLimit = (
  current: RateWindow | null,
  policy: RateLimitPolicy,
  now: number,
): RateDecision => {
  const fresh = !current || now - current.windowStart >= policy.windowMs;
  const window: RateWindow = fresh ? { windowStart: now, count: 0 } : current;
  if (window.count >= policy.limit) {
    return { allowed: false, retryAfterMs: window.windowStart + policy.windowMs - now };
  }
  const next = { windowStart: window.windowStart, count: window.count + 1 };
  return { allowed: true, next, remaining: policy.limit - next.count };
};

/* ============================ WhatsApp: ventana 24 h ============================ */

/**
 * Dentro de las 24 h desde el último mensaje del cliente se puede responder con
 * mensajes de servicio; fuera de la ventana solo plantillas aprobadas.
 */
export const canSendFreeformMessage = (lastInboundAt: Date | null, now: Date): boolean =>
  lastInboundAt !== null &&
  now.getTime() - lastInboundAt.getTime() <
    CHANNEL_LIMITS.WHATSAPP.customerServiceWindowHours * 3_600_000;

/* ================================ Afiliados ================================ */

/** Comisión = venta × tasa (bps), redondeo hacia abajo: nunca se sobreestima. */
export const calculateCommissionCents = (saleCents: number, rateBps: number): number => {
  if (!Number.isSafeInteger(saleCents) || saleCents < 0) throw new RangeError('saleCents');
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) throw new RangeError('rate');
  return Math.floor((saleCents * rateBps) / 10_000);
};

/** Tasa de conversión en bps; null si no hay clics (no se informa una tasa sin datos). */
export const conversionRateBps = (clicks: number, conversions: number): number | null =>
  clicks <= 0 ? null : Math.round((conversions * 10_000) / clicks);

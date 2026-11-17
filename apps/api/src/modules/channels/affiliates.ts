import { and, count, desc, eq, sum } from 'drizzle-orm';
import { calculateCommissionCents, conversionRateBps } from '@vc/business-rules';
import {
  affiliateClicks,
  affiliateConversions,
  affiliateLinks,
  affiliateNetworks,
  affiliateProducts,
  type AffiliateConversionRow,
  type AffiliateNetworkRow,
  type Database,
} from '@vc/database';
import { randomToken } from '@vc/security';
import {
  appError,
  err,
  newId,
  ok,
  RecordConversionRequestSchema,
  type AffiliateConversionDto,
  type AffiliateLinkDto,
  type AffiliateNetworkDto,
  type AffiliateProductDto,
  type AffiliateSummaryDto,
  type ConversionStatus,
  type CreateAffiliateLinkRequest,
  type CreateAffiliateNetworkRequest,
  type CreateAffiliateProductRequest,
  type RecordConversionRequest,
  type Result,
} from '@vc/shared';
import { iso, notFound } from '../../http';

/**
 * Programas de afiliados (gestión local). Sin conector de red especificado:
 * los enlaces de seguimiento los emite la red y se registran acá; las
 * conversiones se cargan con su reporte/fuente. Nada se inventa.
 */

const toNetworkDto = (n: AffiliateNetworkRow): AffiliateNetworkDto => ({
  id: n.id,
  name: n.name,
  website: n.website,
  status: n.status,
  statusDetail:
    n.status === 'DISABLED'
      ? 'Deshabilitada'
      : 'Sin conector de API: enlaces y conversiones se registran manualmente con su fuente',
  termsRef: n.termsRef,
  cookieDays: n.cookieDays,
  createdAt: iso(n.createdAt),
});

export const listNetworks = async (db: Database, tenantId: string) =>
  (
    await db
      .select()
      .from(affiliateNetworks)
      .where(eq(affiliateNetworks.tenantId, tenantId))
      .orderBy(affiliateNetworks.name)
  ).map(toNetworkDto);

export const createNetwork = async (
  db: Database,
  tenantId: string,
  input: CreateAffiliateNetworkRequest,
  now: Date,
): Promise<Result<AffiliateNetworkDto>> => {
  try {
    const row = await db
      .insert(affiliateNetworks)
      .values({
        id: newId(),
        tenantId,
        name: input.name,
        website: input.website ?? null,
        termsRef: input.termsRef ?? null,
        cookieDays: input.cookieDays ?? null,
        status: 'NOT_CONFIGURED',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return ok(toNetworkDto(row));
  } catch {
    return err(appError('CONFLICT', 'Ya existe una red con ese nombre'));
  }
};

export const setNetworkEnabled = async (
  db: Database,
  tenantId: string,
  id: string,
  enabled: boolean,
  now: Date,
): Promise<Result<AffiliateNetworkDto>> => {
  const row = await db
    .update(affiliateNetworks)
    .set({ status: enabled ? 'NOT_CONFIGURED' : 'DISABLED', updatedAt: now })
    .where(and(eq(affiliateNetworks.id, id), eq(affiliateNetworks.tenantId, tenantId)))
    .returning();
  return row[0] ? ok(toNetworkDto(row[0])) : notFound('Red');
};

const findNetwork = (db: Database, tenantId: string, id: string) =>
  db
    .select()
    .from(affiliateNetworks)
    .where(and(eq(affiliateNetworks.id, id), eq(affiliateNetworks.tenantId, tenantId)))
    .get();

export const listAffiliateProducts = async (
  db: Database,
  tenantId: string,
): Promise<AffiliateProductDto[]> =>
  (await db.select().from(affiliateProducts).where(eq(affiliateProducts.tenantId, tenantId))).map(
    (p) => ({
      id: p.id,
      networkId: p.networkId,
      title: p.title,
      productUrl: p.productUrl,
      externalRef: p.externalRef,
      commissionRateBps: p.commissionRateBps,
      commissionSourceRef: p.commissionSourceRef,
      createdAt: iso(p.createdAt),
    }),
  );

export const createAffiliateProduct = async (
  db: Database,
  tenantId: string,
  input: CreateAffiliateProductRequest,
  now: Date,
): Promise<Result<AffiliateProductDto>> => {
  if (!(await findNetwork(db, tenantId, input.networkId))) return notFound('Red');
  const id = newId();
  await db.insert(affiliateProducts).values({
    id,
    tenantId,
    networkId: input.networkId,
    title: input.title,
    productUrl: input.productUrl,
    externalRef: input.externalRef ?? null,
    commissionRateBps: input.commissionRateBps ?? null,
    commissionSourceRef: input.commissionSourceRef ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const [dto] = (await listAffiliateProducts(db, tenantId)).filter((p) => p.id === id);
  return dto ? ok(dto) : notFound('Producto');
};

export const listLinks = async (db: Database, tenantId: string): Promise<AffiliateLinkDto[]> => {
  const links = await db
    .select()
    .from(affiliateLinks)
    .where(eq(affiliateLinks.tenantId, tenantId))
    .orderBy(desc(affiliateLinks.createdAt));
  const clicks = new Map(
    (
      await db
        .select({ linkId: affiliateClicks.linkId, n: count() })
        .from(affiliateClicks)
        .where(eq(affiliateClicks.tenantId, tenantId))
        .groupBy(affiliateClicks.linkId)
    ).map((r) => [r.linkId, r.n]),
  );
  const conversions = new Map(
    (
      await db
        .select({ linkId: affiliateConversions.linkId, n: count() })
        .from(affiliateConversions)
        .where(eq(affiliateConversions.tenantId, tenantId))
        .groupBy(affiliateConversions.linkId)
    ).map((r) => [r.linkId, r.n]),
  );
  return links.map((l) => ({
    id: l.id,
    productId: l.productId,
    networkId: l.networkId,
    code: l.code,
    destinationUrl: l.destinationUrl,
    campaign: l.campaign,
    channel: l.channel,
    active: l.active,
    clicks: clicks.get(l.id) ?? 0,
    conversions: conversions.get(l.id) ?? 0,
    createdAt: iso(l.createdAt),
  }));
};

export const createLink = async (
  db: Database,
  tenantId: string,
  input: CreateAffiliateLinkRequest,
  now: Date,
): Promise<Result<AffiliateLinkDto>> => {
  const product = await db
    .select()
    .from(affiliateProducts)
    .where(and(eq(affiliateProducts.id, input.productId), eq(affiliateProducts.tenantId, tenantId)))
    .get();
  if (!product) return notFound('Producto afiliado');
  const network = await findNetwork(db, tenantId, product.networkId);
  if (network?.status === 'DISABLED') return err(appError('CONFLICT', 'Red deshabilitada'));
  const id = newId();
  await db.insert(affiliateLinks).values({
    id,
    tenantId,
    productId: product.id,
    networkId: product.networkId,
    code: randomToken(9),
    destinationUrl: input.destinationUrl,
    campaign: input.campaign ?? null,
    channel: input.channel ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const [dto] = (await listLinks(db, tenantId)).filter((l) => l.id === id);
  return dto ? ok(dto) : notFound('Enlace');
};

export const setLinkActive = async (
  db: Database,
  tenantId: string,
  id: string,
  active: boolean,
  now: Date,
): Promise<Result<AffiliateLinkDto>> => {
  const row = await db
    .update(affiliateLinks)
    .set({ active, updatedAt: now })
    .where(and(eq(affiliateLinks.id, id), eq(affiliateLinks.tenantId, tenantId)))
    .returning();
  if (!row[0]) return notFound('Enlace');
  const [dto] = (await listLinks(db, tenantId)).filter((l) => l.id === id);
  return dto ? ok(dto) : notFound('Enlace');
};

/**
 * Redirección pública /r/:code: registra el clic (sin IP ni datos personales) y
 * redirige SOLO al destino registrado (no hay redirección abierta).
 */
export const trackClick = async (
  db: Database,
  code: string,
  meta: { referrer: string | undefined; country: string | undefined },
  now: Date,
): Promise<string | null> => {
  const link = await db.select().from(affiliateLinks).where(eq(affiliateLinks.code, code)).get();
  if (!link?.active) return null;
  let referrerHost: string | null;
  try {
    referrerHost = meta.referrer ? new URL(meta.referrer).host : null;
  } catch {
    referrerHost = null;
  }
  await db.insert(affiliateClicks).values({
    id: newId(),
    tenantId: link.tenantId,
    linkId: link.id,
    referrerHost,
    country: meta.country && /^[A-Z]{2}$/.test(meta.country) ? meta.country : null,
    clickedAt: now,
  });
  return link.destinationUrl;
};

const toConversionDto = (c: AffiliateConversionRow): AffiliateConversionDto => ({
  id: c.id,
  linkId: c.linkId,
  networkId: c.networkId,
  externalRef: c.externalRef,
  saleCents: c.saleCents,
  currency: c.currency,
  commissionCents: c.commissionCents,
  status: c.status,
  source: c.source,
  sourceRef: c.sourceRef,
  occurredAt: iso(c.occurredAt),
  recordedAt: iso(c.recordedAt),
});

export const listConversions = async (db: Database, tenantId: string) =>
  (
    await db
      .select()
      .from(affiliateConversions)
      .where(eq(affiliateConversions.tenantId, tenantId))
      .orderBy(desc(affiliateConversions.occurredAt))
  ).map(toConversionDto);

/** Registra una conversión con su respaldo. La comisión sale del dato o de la tasa con fuente. */
export const recordConversion = async (
  db: Database,
  tenantId: string,
  raw: RecordConversionRequest,
  now: Date,
): Promise<Result<AffiliateConversionDto>> => {
  const input = RecordConversionRequestSchema.parse(raw);
  if (new Date(input.occurredAt).getTime() > now.getTime())
    return err(appError('VALIDATION_ERROR', 'La conversión no puede tener fecha futura'));
  const link = await db
    .select()
    .from(affiliateLinks)
    .where(and(eq(affiliateLinks.id, input.linkId), eq(affiliateLinks.tenantId, tenantId)))
    .get();
  if (!link) return notFound('Enlace');
  const product = await db
    .select()
    .from(affiliateProducts)
    .where(eq(affiliateProducts.id, link.productId))
    .get();
  let commissionCents = input.commissionCents;
  if (commissionCents === undefined) {
    if (product?.commissionRateBps === null || product?.commissionRateBps === undefined) {
      return err(
        appError(
          'VALIDATION_ERROR',
          'Sin tasa de comisión registrada: indicar la comisión informada por la red',
        ),
      );
    }
    commissionCents = calculateCommissionCents(input.saleCents, product.commissionRateBps);
  }
  try {
    const row = await db
      .insert(affiliateConversions)
      .values({
        id: newId(),
        tenantId,
        linkId: link.id,
        networkId: link.networkId,
        externalRef: input.externalRef,
        saleCents: input.saleCents,
        currency: input.currency,
        commissionCents,
        status: input.status,
        source: 'MANUAL',
        sourceRef: input.sourceRef,
        occurredAt: new Date(input.occurredAt),
        recordedAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return ok(toConversionDto(row));
  } catch {
    // Idempotencia: la misma referencia de la red no se registra dos veces.
    return err(appError('CONFLICT', 'Esa conversión ya fue registrada'));
  }
};

export const setConversionStatus = async (
  db: Database,
  tenantId: string,
  id: string,
  status: ConversionStatus,
  now: Date,
): Promise<Result<AffiliateConversionDto>> => {
  const row = await db
    .update(affiliateConversions)
    .set({ status, updatedAt: now })
    .where(and(eq(affiliateConversions.id, id), eq(affiliateConversions.tenantId, tenantId)))
    .returning();
  return row[0] ? ok(toConversionDto(row[0])) : notFound('Conversión');
};

export const affiliateSummary = async (
  db: Database,
  tenantId: string,
): Promise<AffiliateSummaryDto> => {
  const clicks =
    (
      await db
        .select({ n: count() })
        .from(affiliateClicks)
        .where(eq(affiliateClicks.tenantId, tenantId))
        .get()
    )?.n ?? 0;
  const rows = await db
    .select({
      currency: affiliateConversions.currency,
      status: affiliateConversions.status,
      n: count(),
      total: sum(affiliateConversions.commissionCents),
    })
    .from(affiliateConversions)
    .where(eq(affiliateConversions.tenantId, tenantId))
    .groupBy(affiliateConversions.currency, affiliateConversions.status);
  const conversions = rows.reduce((a, r) => a + r.n, 0);
  return {
    clicks,
    conversions,
    conversionRateBps: conversionRateBps(clicks, conversions),
    commissions: rows.map((r) => ({
      currency: r.currency,
      status: r.status,
      totalCents: Number(r.total ?? 0),
    })),
  };
};

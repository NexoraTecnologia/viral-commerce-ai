import { and, eq } from 'drizzle-orm';
import { channelConnections, channelListings, tenants, type Database } from '@vc/database';
import { formatMoney, type StoreProductDto } from '@vc/shared';
import type { ChannelListingDto } from '@vc/shared';

/**
 * Tienda propia: catálogo público y páginas de producto (HTML escapado).
 * Solo se exponen publicaciones PUBLISHED de conexiones OWN_STORE en modo LIVE.
 * El checkout es un módulo aparte (CheckoutProvider) y hoy no está configurado.
 */

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) =>
    ch === '&'
      ? '&amp;'
      : ch === '<'
        ? '&lt;'
        : ch === '>'
          ? '&gt;'
          : ch === '"'
            ? '&quot;'
            : '&#39;',
  );

export const findTenantBySlug = (db: Database, slug: string) =>
  db.select().from(tenants).where(eq(tenants.slug, slug)).get();

export const storeCatalog = async (db: Database, tenantId: string): Promise<StoreProductDto[]> => {
  const rows = await db
    .select()
    .from(channelListings)
    .innerJoin(channelConnections, eq(channelListings.connectionId, channelConnections.id))
    .where(
      and(
        eq(channelListings.tenantId, tenantId),
        eq(channelListings.status, 'PUBLISHED'),
        eq(channelConnections.channel, 'OWN_STORE'),
        eq(channelConnections.mode, 'LIVE'),
      ),
    );
  return rows.map((r) => toStoreProduct(r.channel_listings.id, r.channel_listings.draft, false));
};

export const toStoreProduct = (
  listingId: string,
  draft: ChannelListingDto['draft'],
  preview: boolean,
): StoreProductDto => ({
  listingId,
  title: draft.title,
  description: draft.description,
  priceCents: draft.priceCents,
  currency: draft.currency,
  imageUrls: draft.imageUrls,
  preview,
});

/** Página de producto. En vista previa se aclara que no está a la venta. */
export const renderProductPage = (p: StoreProductDto, storeName: string): string => {
  const price = formatMoney({ amountCents: p.priceCents, currency: p.currency });
  const images = p.imageUrls
    .map((u) => `<img src="${escapeHtml(u)}" alt="${escapeHtml(p.title)}" loading="lazy">`)
    .join('');
  const paragraphs = p.description
    .split(/\n{2,}/)
    .map((x) => `<p>${escapeHtml(x).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<!doctype html>
<html lang="es-AR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(p.title)} · ${escapeHtml(storeName)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;color:#1f2328;background:#fff}
main{max-width:860px;margin:0 auto;padding:24px 16px}
.banner{background:#fff4ce;border:1px solid #e6c34a;padding:10px 14px;border-radius:8px;margin-bottom:16px}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
.gallery img{width:100%;border-radius:8px}
.price{font-size:1.6rem;font-weight:700;margin:12px 0}
button{padding:10px 18px;border-radius:8px;border:0;background:#888;color:#fff}
</style></head>
<body><main>
${p.preview ? '<div class="banner">Vista previa: este producto no está publicado ni a la venta.</div>' : ''}
<h1>${escapeHtml(p.title)}</h1>
<div class="gallery">${images}</div>
<div class="price">${escapeHtml(price)}</div>
${paragraphs}
<button disabled title="Checkout no configurado">Compra no disponible</button>
<p><small>El checkout no está habilitado todavía: no se procesan pagos.</small></p>
</main></body></html>`;
};

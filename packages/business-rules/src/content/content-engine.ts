import type {
  AttributeVerification,
  Compliance,
  ContentFields,
  Currency,
  ImageAuthorization,
} from '@vc/shared';
import { formatMoney } from '@vc/shared';
import { containsTerm, normalizeText } from '../discovery/classify';

/**
 * CONTENT ENGINE — plantillas propias, determinísticas (sin IA ni servicios externos).
 *
 * Reglas:
 *  - Solo se usan HECHOS registrados: título, categoría, atributos VERIFIED o
 *    SUPPLIER_DECLARED, precio de venta y condiciones del proveedor.
 *  - Los atributos UNVERIFIED y las imágenes sin autorización se excluyen.
 *  - Ninguna plantilla agrega afirmaciones propias (gratis, garantía, "el mejor"…).
 *  - Si falta un dato, la sección se omite: no se rellena con texto genérico que
 *    sugiera algo no confirmado.
 */
export const CONTENT_TEMPLATE_VERSION = 'v1';

export interface ContentFacts {
  readonly title: string;
  readonly categoryName: string | null;
  readonly attributes: readonly {
    readonly name: string;
    readonly value: string;
    readonly verification: AttributeVerification;
  }[];
  readonly salePrice: { readonly cents: number; readonly currency: Currency } | null;
  readonly supplier: {
    readonly directDispatch: boolean;
    readonly deliveryDaysMin: number | null;
    readonly deliveryDaysMax: number | null;
    readonly trackingAvailable: boolean;
    readonly acceptsReturns: boolean;
    readonly returnWindowDays: number | null;
  } | null;
  readonly images: readonly { readonly url: string; readonly authorization: ImageAuthorization }[];
}

/** Siempre prohibidas: superlativos absolutos y afirmaciones de salud/milagro. */
export const PROHIBITED_TERMS = [
  'el mejor',
  'la mejor',
  'los mejores',
  'las mejores',
  'numero 1',
  'n 1',
  'nro 1',
  'unico en el mercado',
  'milagro',
  'milagroso',
  'cura',
  'curar',
  'sin riesgos',
  'resultados garantizados',
  '100 garantizado',
  'garantia de por vida',
] as const;

/** Solo admisibles si figuran en los hechos registrados (título o atributos). */
export const FACT_REQUIRED_TERMS = [
  'gratis',
  'envio gratis',
  'garantia',
  'garantizado',
  'original',
  'oficial',
  'importado',
  'stock inmediato',
  'oferta',
  'descuento',
] as const;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

const truncate = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : s.slice(0, max)).replace(
    /[\s,;:-]+$/,
    '',
  );
};

/** Nombre comercial: el título registrado, normalizado. Sin agregar adjetivos. */
const commercialNameFrom = (title: string): string => {
  const t = clean(title);
  const letters = t.replace(/[^A-Za-zÁÉÍÓÚÑÜáéíóúñü]/g, '');
  const shouting = letters.length > 3 && letters === letters.toUpperCase();
  const normalized = shouting
    ? t
        .toLowerCase()
        .replace(/(^|\s)(\p{L})/gu, (_m, sp: string, ch: string) => sp + ch.toUpperCase())
    : t;
  return truncate(normalized, 80);
};

const deliveryText = (s: NonNullable<ContentFacts['supplier']>): string | null => {
  if (!s.directDispatch || s.deliveryDaysMax === null) return null;
  return s.deliveryDaysMin !== null && s.deliveryDaysMin !== s.deliveryDaysMax
    ? `entre ${s.deliveryDaysMin} y ${s.deliveryDaysMax} días`
    : `hasta ${s.deliveryDaysMax} días`;
};

const hashtagsFrom = (name: string, category: string | null): string[] => {
  const words = normalizeText(`${category ?? ''} ${name}`)
    .split(' ')
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w));
  return [...new Set(words)].slice(0, 5).map((w) => `#${w}`);
};

export interface GeneratedContent {
  readonly content: ContentFields;
  readonly compliance: Compliance;
}

export const generateContent = (facts: ContentFacts): GeneratedContent => {
  const name = commercialNameFrom(facts.title);
  const usable = facts.attributes.filter((a) => a.verification !== 'UNVERIFIED');
  const features = usable.map(
    (a) =>
      `${clean(a.name)}: ${clean(a.value)}${a.verification === 'SUPPLIER_DECLARED' ? ' (según el proveedor)' : ''}`,
  );

  const s = facts.supplier;
  const delivery = s ? deliveryText(s) : null;
  const benefits: string[] = [];
  if (delivery) benefits.push(`Entrega estimada ${delivery} desde la compra.`);
  if (s?.trackingAvailable) benefits.push('Envío con número de seguimiento.');
  if (s?.acceptsReturns && s.returnWindowDays !== null) {
    benefits.push(`Podés solicitar la devolución dentro de los ${s.returnWindowDays} días.`);
  }

  const price = facts.salePrice
    ? formatMoney({ amountCents: facts.salePrice.cents, currency: facts.salePrice.currency })
    : null;

  const faq: { question: string; answer: string }[] = [];
  if (features.length)
    faq.push({ question: '¿Qué características tiene?', answer: features.join('. ') + '.' });
  if (delivery)
    faq.push({
      question: '¿Cuánto tarda el envío?',
      answer: `La entrega estimada es ${delivery} desde la compra.`,
    });
  if (s) {
    faq.push({
      question: '¿Tiene seguimiento?',
      answer: s.trackingAvailable
        ? 'Sí, el envío incluye número de seguimiento.'
        : 'Por el momento este envío no incluye seguimiento.',
    });
    if (s.acceptsReturns && s.returnWindowDays !== null) {
      faq.push({
        question: '¿Puedo devolverlo?',
        answer: `Sí, dentro de los ${s.returnWindowDays} días de recibido.`,
      });
    } else if (!s.acceptsReturns) {
      faq.push({
        question: '¿Puedo devolverlo?',
        answer: 'Este producto no admite devoluciones por parte del proveedor.',
      });
    }
  }
  if (price) faq.push({ question: '¿Cuál es el precio?', answer: `${price}.` });

  const category = facts.categoryName ? clean(facts.categoryName) : null;
  const seoTitle =
    category && `${name} | ${category}`.length <= 60 ? `${name} | ${category}` : truncate(name, 60);

  const description = [
    `${name}.`,
    category ? `Categoría: ${category}.` : null,
    features.length ? `Características: ${features.join('; ')}.` : null,
    ...benefits,
  ]
    .filter(Boolean)
    .join(' ');

  const instagram = [
    name,
    ...features.slice(0, 3).map((f) => `• ${f}`),
    benefits[0] ?? null,
    price ? `Precio: ${price}` : null,
    'Consultas por mensaje directo.',
    hashtagsFrom(name, category).join(' ') || null,
  ]
    .filter(Boolean)
    .join('\n');

  const whatsapp = [
    `Hola, te comparto: ${name}.`,
    price ? `Precio: ${price}.` : null,
    delivery ? `Entrega estimada ${delivery}.` : null,
    '¿Te interesa? Respondé este mensaje y te paso más información.',
  ]
    .filter(Boolean)
    .join('\n');

  const shippingLines = [
    delivery ? `Entrega estimada ${delivery} desde la compra.` : null,
    s ? (s.trackingAvailable ? 'Envío con seguimiento.' : 'Envío sin seguimiento.') : null,
    s?.acceptsReturns && s.returnWindowDays !== null
      ? `Devoluciones dentro de los ${s.returnWindowDays} días.`
      : null,
    s && !s.acceptsReturns ? 'No admite devoluciones.' : null,
  ].filter((x): x is string => x !== null);

  const storeDescription = [
    `${name}${category ? ` — ${category}` : ''}`,
    features.length ? `Características:\n${features.map((f) => `- ${f}`).join('\n')}` : null,
    shippingLines.length
      ? `Envío y devoluciones:\n${shippingLines.map((l) => `- ${l}`).join('\n')}`
      : null,
    price ? `Precio: ${price}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  // Marketplaces: texto plano, sin emojis, enlaces ni datos de contacto.
  const marketplaceDescription = [
    name.toUpperCase(),
    features.length ? `CARACTERÍSTICAS\n${features.map((f) => `- ${f}`).join('\n')}` : null,
    shippingLines.length
      ? `ENVÍO Y DEVOLUCIONES\n${shippingLines.map((l) => `- ${l}`).join('\n')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  const authorizedImages = facts.images.filter((i) => i.authorization !== 'NONE').map((i) => i.url);

  const content: ContentFields = {
    commercialName: name,
    seoTitle,
    description,
    features,
    benefits,
    faq,
    instagram,
    whatsapp,
    storeDescription,
    marketplaceDescription,
    images: authorizedImages,
  };

  return {
    content,
    compliance: checkCompliance(content, facts),
  };
};

/**
 * Revisa el contenido generado. Las plantillas no introducen estos términos, así
 * que una violación indica que el título o un atributo registrado trae una
 * afirmación que no corresponde publicar sin revisión.
 */
export const checkCompliance = (content: ContentFields, facts: ContentFacts): Compliance => {
  const factsText = [
    facts.title,
    ...facts.attributes
      .filter((a) => a.verification !== 'UNVERIFIED')
      .map((a) => `${a.name} ${a.value}`),
  ].join(' ');
  const fields: [string, string][] = [
    ['commercialName', content.commercialName],
    ['seoTitle', content.seoTitle],
    ['description', content.description],
    ['features', content.features.join(' ')],
    ['benefits', content.benefits.join(' ')],
    ['faq', content.faq.map((f) => `${f.question} ${f.answer}`).join(' ')],
    ['instagram', content.instagram],
    ['whatsapp', content.whatsapp],
    ['storeDescription', content.storeDescription],
    ['marketplaceDescription', content.marketplaceDescription],
  ];
  const violations: Compliance['violations'] = [];
  for (const [field, text] of fields) {
    for (const term of PROHIBITED_TERMS) {
      if (containsTerm(text, term)) violations.push({ field, term, rule: 'PROHIBITED_CLAIM' });
    }
    for (const term of FACT_REQUIRED_TERMS) {
      if (containsTerm(text, term) && !containsTerm(factsText, term)) {
        violations.push({ field, term, rule: 'UNSUPPORTED_CLAIM' });
      }
    }
    if (
      field === 'marketplaceDescription' &&
      /(https?:\/\/|www\.|@|\+?\d[\d\s-]{7,})/i.test(text)
    ) {
      violations.push({ field, term: 'contacto/enlace', rule: 'MARKETPLACE_CONTACT_INFO' });
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    excludedAttributes:
      facts.attributes.length -
      facts.attributes.filter((a) => a.verification !== 'UNVERIFIED').length,
    excludedImages: facts.images.filter((i) => i.authorization === 'NONE').length,
  };
};

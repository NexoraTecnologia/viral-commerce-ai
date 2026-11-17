import { describe, expect, it } from 'vitest';
import { generateContent, type ContentFacts } from './content-engine';

const facts: ContentFacts = {
  title: 'Organizador de cocina de bambú',
  categoryName: 'Hogar',
  attributes: [
    { name: 'Material', value: 'Bambú', verification: 'VERIFIED' },
    { name: 'Medidas', value: '30 x 20 cm', verification: 'SUPPLIER_DECLARED' },
    { name: 'Capacidad', value: '10 kg', verification: 'UNVERIFIED' },
  ],
  salePrice: { cents: 2_599_990, currency: 'ARS' },
  supplier: {
    directDispatch: true,
    deliveryDaysMin: 2,
    deliveryDaysMax: 5,
    trackingAvailable: true,
    acceptsReturns: true,
    returnWindowDays: 30,
  },
  images: [
    { url: 'https://example.com/propia.jpg', authorization: 'OWN_PHOTO' },
    { url: 'https://example.com/ajena.jpg', authorization: 'NONE' },
  ],
};

const allText = (c: ReturnType<typeof generateContent>['content']) =>
  [
    c.commercialName,
    c.seoTitle,
    c.description,
    ...c.features,
    ...c.benefits,
    ...c.faq.flatMap((f) => [f.question, f.answer]),
    c.instagram,
    c.whatsapp,
    c.storeDescription,
    c.marketplaceDescription,
  ].join('\n');

describe('Content Engine', () => {
  it('genera todos los campos a partir de hechos registrados', () => {
    const { content, compliance } = generateContent(facts);
    expect(content.commercialName).toBe('Organizador de cocina de bambú');
    expect(content.seoTitle).toBe('Organizador de cocina de bambú | Hogar');
    expect(content.features).toEqual([
      'Material: Bambú',
      'Medidas: 30 x 20 cm (según el proveedor)',
    ]);
    expect(content.benefits).toEqual([
      'Entrega estimada entre 2 y 5 días desde la compra.',
      'Envío con número de seguimiento.',
      'Podés solicitar la devolución dentro de los 30 días.',
    ]);
    expect(content.faq.map((f) => f.question)).toEqual([
      '¿Qué características tiene?',
      '¿Cuánto tarda el envío?',
      '¿Tiene seguimiento?',
      '¿Puedo devolverlo?',
      '¿Cuál es el precio?',
    ]);
    expect(content.whatsapp).toContain('Precio: $');
    expect(content.instagram).toContain('#hogar');
    expect(compliance).toEqual({
      ok: true,
      violations: [],
      excludedAttributes: 1,
      excludedImages: 1,
    });
  });

  it('no usa atributos sin verificar ni imágenes sin autorización', () => {
    const { content } = generateContent(facts);
    expect(allText(content)).not.toContain('10 kg');
    expect(content.images).toEqual(['https://example.com/propia.jpg']);
  });

  it('omite secciones sin datos en lugar de inventarlas', () => {
    const { content } = generateContent({
      title: 'Lámpara LED',
      categoryName: null,
      attributes: [],
      salePrice: null,
      supplier: null,
      images: [],
    });
    expect(content.features).toEqual([]);
    expect(content.benefits).toEqual([]);
    expect(content.faq).toEqual([]);
    expect(allText(content)).not.toMatch(/env[ií]o|precio|devoluci|garant/i);
  });

  it('no promete envío ni devoluciones que el proveedor no ofrece', () => {
    const { content } = generateContent({
      ...facts,
      supplier: {
        ...(facts.supplier as NonNullable<ContentFacts['supplier']>),
        trackingAvailable: false,
        acceptsReturns: false,
        deliveryDaysMax: null,
      },
    });
    const text = allText(content);
    expect(text).not.toContain('Entrega estimada');
    expect(text).toContain('No admite devoluciones');
    expect(text).not.toContain('Envío con seguimiento');
  });

  it('las plantillas nunca agregan "gratis", "garantía" ni superlativos', () => {
    const text = allText(generateContent(facts).content).toLowerCase();
    for (const term of ['gratis', 'garantía', 'el mejor', 'original', 'oferta'])
      expect(text).not.toContain(term);
  });

  it('marca afirmaciones prohibidas o sin respaldo que vengan del título', () => {
    const { compliance } = generateContent({
      ...facts,
      title: 'EL MEJOR organizador ENVÍO GRATIS',
    });
    expect(compliance.ok).toBe(false);
    expect(compliance.violations.map((v) => v.rule)).toEqual(
      expect.arrayContaining(['PROHIBITED_CLAIM']),
    );
  });

  it('"garantía" se admite solo si está en un atributo verificado', () => {
    const withWarranty = generateContent({
      ...facts,
      attributes: [{ name: 'Garantía', value: '6 meses del fabricante', verification: 'VERIFIED' }],
    });
    expect(withWarranty.compliance.ok).toBe(true);
  });

  it('normaliza títulos en mayúsculas sin agregar adjetivos', () => {
    expect(
      generateContent({ ...facts, title: 'ORGANIZADOR DE COCINA' }).content.commercialName,
    ).toBe('Organizador De Cocina');
  });
});

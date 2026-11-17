import { describe, expect, it } from 'vitest';
import type { ListingDraft } from '@vc/shared';
import {
  calculateCommissionCents,
  canSendFreeformMessage,
  checkChannelPolicy,
  consumeRateLimit,
  conversionRateBps,
  evaluatePublishGate,
  type PublishGateInput,
} from './channel-rules';

const draft = (over: Partial<ListingDraft> = {}): ListingDraft => ({
  title: 'Organizador de cocina',
  description: 'Descripción',
  priceCents: 100_000,
  currency: 'ARS',
  quantity: 3,
  imageUrls: ['https://cdn.example.com/a.jpg'],
  caption: 'Organizador #cocina',
  categoryId: 'MLA1234',
  listingTypeId: 'gold_pro',
  condition: 'new',
  ...over,
});

const NOW = new Date('2026-11-17T12:00:00Z');

const SUPPLIER_OK = {
  status: 'VERIFIED',
  directDispatch: true,
  dispatchLeadTimeDaysMax: 1,
  deliveryTimeDaysMax: 5,
};

const gateInput = (over: Partial<PublishGateInput> = {}): PublishGateInput => ({
  supplier: {
    status: 'VERIFIED',
    directDispatch: true,
    dispatchLeadTimeDaysMax: 1,
    deliveryTimeDaysMax: 5,
  },
  stock: { status: 'IN_STOCK', quantity: 10, ageHours: 2, maxAgeHours: 24, requiredQuantity: 1 },
  marginBps: 2500,
  minMarginBps: 2000,
  policyIssues: [],
  riskPassed: true,
  riskBlockers: [],
  connection: { mode: 'LIVE', status: 'CONNECTED', scopes: ['write'], requiredScopes: ['write'] },
  commercialActionsEnabled: true,
  now: NOW,
  ...over,
});

describe('políticas por canal', () => {
  it('Mercado Libre exige categoría, tipo, condición, ARS, stock e imagen', () => {
    expect(checkChannelPolicy('MERCADO_LIBRE', draft(), null)).toEqual([]);
    const codes = checkChannelPolicy(
      'MERCADO_LIBRE',
      draft({
        categoryId: null,
        listingTypeId: null,
        condition: null,
        currency: 'USD',
        quantity: 0,
        imageUrls: [],
      }),
      null,
    ).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'CATEGORY_REQUIRED',
        'LISTING_TYPE_REQUIRED',
        'CONDITION_REQUIRED',
        'CURRENCY',
        'QUANTITY',
        'IMAGE_REQUIRED',
      ]),
    );
  });

  it('Instagram: solo JPEG, caption ≤ 2200, ≤ 30 hashtags, ≤ 20 menciones', () => {
    expect(checkChannelPolicy('INSTAGRAM', draft(), null)).toEqual([]);
    const codes = checkChannelPolicy(
      'INSTAGRAM',
      draft({
        imageUrls: ['https://cdn.example.com/a.png'],
        caption: `${'x'.repeat(2201)} ${Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ')} ${Array.from({ length: 21 }, (_, i) => `@u${i}`).join(' ')}`,
      }),
      null,
    ).map((i) => i.code);
    expect(codes).toEqual(['JPEG_ONLY', 'CAPTION_LENGTH', 'HASHTAGS', 'MENTIONS']);
  });

  it('WhatsApp y afiliados no admiten publicaciones; compliance fallido bloquea', () => {
    expect(checkChannelPolicy('WHATSAPP', draft(), null)[0]?.code).toBe('CHANNEL_HAS_NO_LISTINGS');
    expect(checkChannelPolicy('AFFILIATE', draft(), null)[0]?.code).toBe('CHANNEL_HAS_NO_LISTINGS');
    const issues = checkChannelPolicy('OWN_STORE', draft(), {
      ok: false,
      violations: [{ field: 'description', term: 'el mejor', rule: 'PROHIBITED' }],
      excludedAttributes: 0,
      excludedImages: 0,
    });
    expect(issues.map((i) => i.code)).toEqual(['CONTENT_COMPLIANCE']);
  });
});

describe('publicación automática (gate)', () => {
  it('permite solo con TODAS las condiciones', () => {
    const r = evaluatePublishGate(gateInput());
    expect(r.allowed).toBe(true);
    expect(r.checks.every((c) => c.passed)).toBe(true);
  });

  it.each([
    ['SUPPLIER_VERIFIED', { supplier: { ...SUPPLIER_OK, status: 'UNVERIFIED' } }],
    ['STOCK_VERIFIABLE', { stock: null }],
    [
      'STOCK_VERIFIABLE',
      {
        stock: {
          status: 'IN_STOCK',
          quantity: 5,
          ageHours: 30,
          maxAgeHours: 24,
          requiredQuantity: 1,
        },
      },
    ],
    [
      'STOCK_VERIFIABLE',
      {
        stock: {
          status: 'OUT_OF_STOCK',
          quantity: 0,
          ageHours: 1,
          maxAgeHours: 24,
          requiredQuantity: 1,
        },
      },
    ],
    ['MIN_MARGIN', { marginBps: 1999 }],
    ['MIN_MARGIN', { marginBps: null }],
    ['LOGISTICS_CAPACITY', { supplier: { ...SUPPLIER_OK, deliveryTimeDaysMax: null } }],
    ['CHANNEL_POLICY', { policyIssues: [{ code: 'X', message: 'x' }] }],
    ['RISK_GUARDIAN', { riskPassed: false, riskBlockers: ['SUPPLIER_VERIFIED'] }],
    [
      'INTEGRATION_AUTHORIZED',
      { connection: { ...gateInput().connection, status: 'EXPIRED' as const } },
    ],
    ['INTEGRATION_AUTHORIZED', { connection: { ...gateInput().connection, scopes: ['read'] } }],
    ['COMMERCIAL_ACTIONS_ENABLED', { commercialActionsEnabled: false }],
  ] as const)('bloquea si falla %s', (check, over) => {
    const r = evaluatePublishGate(gateInput(over));
    expect(r.allowed).toBe(false);
    expect(r.checks.find((c) => c.check === check)?.passed).toBe(false);
  });

  it('una conexión MOCK nunca habilita publicación real, solo simulada', () => {
    const r = evaluatePublishGate(
      gateInput({
        connection: {
          mode: 'MOCK',
          status: 'CONNECTED',
          scopes: ['write'],
          requiredScopes: ['write'],
        },
        commercialActionsEnabled: false,
      }),
    );
    expect(r.allowed).toBe(false);
    expect(r.allowedInMock).toBe(true);
  });

  it('MOCK tampoco simula si falla una regla de negocio', () => {
    const r = evaluatePublishGate(
      gateInput({
        connection: { mode: 'MOCK', status: 'CONNECTED', scopes: [], requiredScopes: [] },
        riskPassed: false,
      }),
    );
    expect(r.allowedInMock).toBe(false);
  });
});

describe('rate limiting', () => {
  const policy = { limit: 2, windowMs: 1000 };
  it('ventana fija: consume, bloquea y reinicia', () => {
    const a = consumeRateLimit(null, policy, 0);
    expect(a).toMatchObject({ allowed: true, remaining: 1 });
    const b = consumeRateLimit(a.allowed ? a.next : null, policy, 100);
    expect(b).toMatchObject({ allowed: true, remaining: 0 });
    const c = consumeRateLimit(b.allowed ? b.next : null, policy, 200);
    expect(c).toEqual({ allowed: false, retryAfterMs: 800 });
    const d = consumeRateLimit({ windowStart: 0, count: 2 }, policy, 1000);
    expect(d).toMatchObject({ allowed: true, remaining: 1 });
  });
});

describe('WhatsApp ventana de 24 h', () => {
  it('texto libre solo dentro de las 24 h del último mensaje del cliente', () => {
    expect(canSendFreeformMessage(null, NOW)).toBe(false);
    expect(canSendFreeformMessage(new Date(NOW.getTime() - 23 * 3_600_000), NOW)).toBe(true);
    expect(canSendFreeformMessage(new Date(NOW.getTime() - 24 * 3_600_000), NOW)).toBe(false);
  });
});

describe('afiliados', () => {
  it('comisión en centavos redondeada hacia abajo y tasa de conversión sin inventar', () => {
    expect(calculateCommissionCents(10_001, 750)).toBe(750);
    expect(calculateCommissionCents(0, 750)).toBe(0);
    expect(() => calculateCommissionCents(100, 10_001)).toThrow(RangeError);
    expect(conversionRateBps(0, 0)).toBeNull();
    expect(conversionRateBps(200, 3)).toBe(150);
  });
});

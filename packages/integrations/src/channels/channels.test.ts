import { describe, expect, it } from 'vitest';
import { CHANNEL_OPERATIONS, type ChannelKind, type ListingDraft } from '@vc/shared';
import {
  createChannelAdapter,
  ML_API,
  sendWhatsAppMessage,
  toWhatsAppPayload,
  type AdapterContext,
  type TokenSet,
} from './index';

/**
 * Pruebas de adaptadores SIN red: `fetch` es un doble que registra cada llamada
 * y responde lo que el test define. Credenciales y tokens son valores de prueba.
 */
interface Call {
  url: string;
  method: string;
  body: string | null;
  headers: Record<string, string>;
}

const fakeFetch = (responder: (call: Call) => { status?: number; json?: unknown }) => {
  const calls: Call[] = [];
  const fn = (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const r = responder(call);
    return Promise.resolve(
      new Response(JSON.stringify(r.json ?? {}), {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fn: fn, calls };
};

const hmacHex = async (secret: string, body: string) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
};
const verifier: AdapterContext['verifySignature'] = async (secret, body, header) =>
  Boolean(
    secret && header?.startsWith('sha256=') && header.slice(7) === (await hmacHex(secret, body)),
  );

const NOW = new Date('2026-11-17T12:00:00Z');
const TOKENS: TokenSet = {
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  expiresAt: new Date(NOW.getTime() + 3_600_000),
  scopes: ['offline_access', 'read', 'write'],
  externalAccountId: '123456',
};

const ctxOf = (fetchFn: typeof fetch, over: Partial<AdapterContext> = {}): AdapterContext => ({
  fetch: fetchFn,
  now: () => NOW,
  credentials: {
    clientId: 'test-app-id',
    clientSecret: 'test-client-secret',
    webhookSecret: 'test-webhook-secret',
    webhookVerifyToken: 'test-verify-token',
  },
  tokens: TOKENS,
  verifySignature: verifier,
  allowWrites: false,
  ...over,
});

const DRAFT: ListingDraft = {
  title: 'Organizador de cocina',
  description: 'Descripción',
  priceCents: 123_450,
  currency: 'ARS',
  quantity: 2,
  imageUrls: ['https://cdn.example.com/a.jpg'],
  caption: 'Organizador',
  categoryId: 'MLA1234',
  listingTypeId: 'gold_pro',
  condition: 'new',
};

const noNetwork = () => fakeFetch(() => ({ status: 599 }));

/* ================================ Mercado Libre ================================ */

describe('Mercado Libre', () => {
  it('arma la URL de autorización de Argentina con state y PKCE S256', async () => {
    const f = noNetwork();
    const a = createChannelAdapter('MERCADO_LIBRE', 'LIVE', ctxOf(f.fn));
    const r = await a.connect({
      type: 'authorize',
      state: 'st',
      redirectUri: 'https://api.example.com/oauth/callback/mercadolibre',
      codeChallenge: 'ch',
    });
    expect(r.ok && r.value.type === 'redirect').toBe(true);
    if (!r.ok || r.value.type !== 'redirect') return;
    const url = new URL(r.value.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://auth.mercadolibre.com.ar/authorization');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'test-app-id',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
    expect(f.calls).toHaveLength(0);
  });

  it('intercambia el code por tokens (form POST a /oauth/token) y usa expires_in', async () => {
    const f = fakeFetch(() => ({
      json: {
        access_token: 'APP_USR-x',
        token_type: 'bearer',
        expires_in: 10800,
        scope: 'offline_access read write',
        user_id: 777,
        refresh_token: 'TG-x',
      },
    }));
    const a = createChannelAdapter('MERCADO_LIBRE', 'LIVE', ctxOf(f.fn, { tokens: null }));
    const r = await a.connect({
      type: 'exchange_code',
      code: 'c',
      redirectUri: 'https://r',
      codeVerifier: 'v',
    });
    expect(f.calls[0]?.url).toBe(`${ML_API}/oauth/token`);
    expect(f.calls[0]?.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]?.body ?? ''))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'test-app-id',
      client_secret: 'test-client-secret',
      code: 'c',
      redirect_uri: 'https://r',
      code_verifier: 'v',
    });
    expect(r.ok && r.value.type === 'tokens' && r.value.tokens).toMatchObject({
      externalAccountId: '777',
      scopes: ['offline_access', 'read', 'write'],
      expiresAt: new Date(NOW.getTime() + 10_800_000),
    });
  });

  it('renueva con refresh_token (de uso único: se reemplaza)', async () => {
    const f = fakeFetch(() => ({
      json: {
        access_token: 'new',
        token_type: 'bearer',
        expires_in: 21600,
        user_id: '123456',
        refresh_token: 'TG-new',
      },
    }));
    const r = await createChannelAdapter('MERCADO_LIBRE', 'LIVE', ctxOf(f.fn)).refreshTokens();
    expect(new URLSearchParams(f.calls[0]?.body ?? '').get('grant_type')).toBe('refresh_token');
    expect(r.ok && r.value).toMatchObject({ accessToken: 'new', refreshToken: 'TG-new' });
  });

  it('sin credenciales de la app queda NOT_CONFIGURED y no llama a la red', async () => {
    const f = noNetwork();
    const a = createChannelAdapter('MERCADO_LIBRE', 'LIVE', ctxOf(f.fn, { credentials: {} }));
    const r = await a.connect({ type: 'authorize', state: 's', redirectUri: 'https://r' });
    expect(!r.ok && r.error.code).toBe('INTEGRATION_NOT_CONFIGURED');
    expect(f.calls).toHaveLength(0);
  });

  it('estado: CONNECTED solo tras GET /users/me; token vencido → EXPIRED; 401 → EXPIRED', async () => {
    const ok = fakeFetch(() => ({ json: { id: 123456, nickname: 'TESTUSER' } }));
    const s1 = await createChannelAdapter(
      'MERCADO_LIBRE',
      'LIVE',
      ctxOf(ok.fn),
    ).getConnectionStatus();
    expect(s1.ok && s1.value).toMatchObject({
      status: 'CONNECTED',
      externalAccountName: 'TESTUSER',
    });
    expect(ok.calls[0]?.headers['authorization']).toBe('Bearer test-access-token');

    const f = noNetwork();
    const expired = { ...TOKENS, expiresAt: new Date(NOW.getTime() - 1) };
    const s2 = await createChannelAdapter(
      'MERCADO_LIBRE',
      'LIVE',
      ctxOf(f.fn, { tokens: expired }),
    ).getConnectionStatus();
    expect(s2.ok && s2.value.status).toBe('EXPIRED');
    expect(f.calls).toHaveLength(0);

    const denied = fakeFetch(() => ({ status: 401 }));
    const s3 = await createChannelAdapter(
      'MERCADO_LIBRE',
      'LIVE',
      ctxOf(denied.fn),
    ).getConnectionStatus();
    expect(s3.ok && s3.value.status).toBe('EXPIRED');

    const none = await createChannelAdapter(
      'MERCADO_LIBRE',
      'LIVE',
      ctxOf(f.fn, { tokens: null }),
    ).getConnectionStatus();
    expect(none.ok && none.value.status).toBe('NOT_CONFIGURED');
  });

  it('escrituras bloqueadas con allowWrites=false: no sale ningún request', async () => {
    const f = noNetwork();
    const a = createChannelAdapter('MERCADO_LIBRE', 'LIVE', ctxOf(f.fn));
    for (const r of [
      await a.createListing(DRAFT, 'k'),
      await a.updateListing('MLA1', DRAFT),
      await a.pauseListing('MLA1'),
    ]) {
      expect(!r.ok && r.error.code).toBe('COMMERCIAL_ACTIONS_DISABLED');
    }
    expect(f.calls).toHaveLength(0);
  });

  it('con escrituras habilitadas: POST /items con el cuerpo documentado y pausa con status paused', async () => {
    const f = fakeFetch((c) => ({
      json: {
        id: 'MLA1',
        status: c.method === 'PUT' ? 'paused' : 'active',
        permalink: 'https://articulo.mercadolibre.com.ar/MLA-1',
      },
    }));
    const a = createChannelAdapter('MERCADO_LIBRE', 'LIVE', ctxOf(f.fn, { allowWrites: true }));
    const created = await a.createListing(DRAFT, 'k');
    expect(created.ok && created.value).toMatchObject({ externalId: 'MLA1', status: 'PUBLISHED' });
    expect(f.calls[0]?.url).toBe(`${ML_API}/items`);
    expect(JSON.parse(f.calls[0]?.body ?? '{}')).toEqual({
      title: 'Organizador de cocina',
      category_id: 'MLA1234',
      price: 1234.5,
      currency_id: 'ARS',
      available_quantity: 2,
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_pro',
      condition: 'new',
      pictures: [{ source: 'https://cdn.example.com/a.jpg' }],
    });
    const paused = await a.pauseListing('MLA1');
    expect(paused.ok && paused.value.status).toBe('PAUSED');
    expect(JSON.parse(f.calls[1]?.body ?? '{}')).toEqual({ status: 'paused' });
  });

  it('sin category_id / tipo / condición no publica (no se inventan valores por defecto)', async () => {
    const f = noNetwork();
    const a = createChannelAdapter('MERCADO_LIBRE', 'LIVE', ctxOf(f.fn, { allowWrites: true }));
    const r = await a.createListing({ ...DRAFT, listingTypeId: null }, 'k');
    expect(!r.ok && r.error.code).toBe('VALIDATION_ERROR');
    expect(f.calls).toHaveLength(0);
  });

  it('pedidos: /orders/search?seller= y normaliza estado conservando el original', async () => {
    const f = fakeFetch(() => ({
      json: {
        results: [
          {
            id: 2000001,
            status: 'paid',
            total_amount: 1500.5,
            currency_id: 'ARS',
            date_created: '2026-11-16T10:00:00.000-03:00',
          },
          { id: 2000002, status: 'algo_nuevo', total_amount: null, currency_id: 'ARS' },
        ],
      },
    }));
    const r = await createChannelAdapter('MERCADO_LIBRE', 'LIVE', ctxOf(f.fn)).getOrders({
      limit: 50,
      offset: 0,
    });
    expect(new URL(f.calls[0]?.url ?? '').searchParams.get('seller')).toBe('123456');
    expect(r.ok && r.value).toEqual([
      expect.objectContaining({
        externalOrderId: '2000001',
        status: 'PAID',
        rawStatus: 'paid',
        totalCents: 150_050,
      }),
      expect.objectContaining({ externalOrderId: '2000002', status: 'OTHER', totalCents: null }),
    ]);
  });

  it('429 de la API → RATE_LIMITED; 500 → UPSTREAM_ERROR', async () => {
    const limited = fakeFetch(() => ({ status: 429 }));
    const r1 = await createChannelAdapter(
      'MERCADO_LIBRE',
      'LIVE',
      ctxOf(limited.fn),
    ).getOrderStatus('1');
    expect(!r1.ok && r1.error.code).toBe('RATE_LIMITED');
    const down = fakeFetch(() => ({ status: 500 }));
    const r2 = await createChannelAdapter('MERCADO_LIBRE', 'LIVE', ctxOf(down.fn)).getOrderStatus(
      '1',
    );
    expect(!r2.ok && r2.error.code).toBe('UPSTREAM_ERROR');
  });

  it('notificaciones: sin firma → se valida application_id; clave de idempotencia estable', async () => {
    const a = createChannelAdapter('MERCADO_LIBRE', 'LIVE', ctxOf(noNetwork().fn));
    const body = (appId: string, attempts: number) =>
      JSON.stringify({
        resource: '/orders/2195160686',
        user_id: 468424240,
        topic: 'orders_v2',
        application_id: appId,
        attempts,
        sent: `2026-11-17T10:0${attempts}:00.000Z`,
        received: '2026-11-17T10:00:00.000Z',
      });
    const req = (raw: string) => ({
      method: 'POST' as const,
      rawBody: raw,
      headers: {},
      query: {},
    });
    const foreign = await a.handleWebhook(req(body('999', 1)));
    expect(foreign.ok && foreign.value.type).toBe('rejected');
    const first = await a.handleWebhook(req(body('test-app-id', 1)));
    const retry = await a.handleWebhook(req(body('test-app-id', 2)));
    if (!first.ok || first.value.type !== 'events' || !retry.ok || retry.value.type !== 'events')
      throw new Error('x');
    expect(first.value.events[0]).toMatchObject({
      topic: 'orders_v2',
      resource: '/orders/2195160686',
      externalAccountId: '468424240',
    });
    expect(first.value.events[0]?.dedupeKey).toBe(retry.value.events[0]?.dedupeKey);
    const junk = await a.handleWebhook(req('{nope'));
    expect(junk.ok && junk.value.type).toBe('rejected');
  });
});

/* ================================== Instagram ================================== */

describe('Instagram', () => {
  it('OAuth Instagram Login: URL de autorización con permisos de publicación', async () => {
    const a = createChannelAdapter('INSTAGRAM', 'LIVE', ctxOf(noNetwork().fn));
    const r = await a.connect({ type: 'authorize', state: 's', redirectUri: 'https://r' });
    if (!r.ok || r.value.type !== 'redirect') throw new Error('x');
    const url = new URL(r.value.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe(
      'instagram_business_basic,instagram_business_content_publish',
    );
  });

  it('code → token corto → token largo de 60 días (dos llamadas)', async () => {
    const f = fakeFetch((c) =>
      c.url.startsWith('https://api.instagram.com')
        ? {
            json: {
              data: [
                {
                  access_token: 'short',
                  user_id: '17841',
                  permissions: 'instagram_business_basic,instagram_business_content_publish',
                },
              ],
            },
          }
        : { json: { access_token: 'long', token_type: 'bearer', expires_in: 5_184_000 } },
    );
    const a = createChannelAdapter('INSTAGRAM', 'LIVE', ctxOf(f.fn, { tokens: null }));
    const r = await a.connect({ type: 'exchange_code', code: 'abc#_', redirectUri: 'https://r' });
    expect(new URLSearchParams(f.calls[0]?.body ?? '').get('code')).toBe('abc');
    expect(new URL(f.calls[1]?.url ?? '').searchParams.get('grant_type')).toBe('ig_exchange_token');
    expect(r.ok && r.value.type === 'tokens' && r.value.tokens).toMatchObject({
      accessToken: 'long',
      externalAccountId: '17841',
      scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
      expiresAt: new Date(NOW.getTime() + 5_184_000_000),
    });
  });

  it('renovación: exige token con ≥ 24 h y no vencido', async () => {
    const fresh = { ...TOKENS, expiresAt: new Date(NOW.getTime() + 60 * 86_400_000) };
    const f = noNetwork();
    const r = await createChannelAdapter(
      'INSTAGRAM',
      'LIVE',
      ctxOf(f.fn, { tokens: fresh }),
    ).refreshTokens();
    expect(!r.ok && r.error.code).toBe('CONFLICT');
    expect(f.calls).toHaveLength(0);
    const ok = fakeFetch(() => ({ json: { access_token: 'renewed', expires_in: 5_184_000 } }));
    const old = { ...TOKENS, expiresAt: new Date(NOW.getTime() + 30 * 86_400_000) };
    const r2 = await createChannelAdapter(
      'INSTAGRAM',
      'LIVE',
      ctxOf(ok.fn, { tokens: old }),
    ).refreshTokens();
    expect(new URL(ok.calls[0]?.url ?? '').searchParams.get('grant_type')).toBe('ig_refresh_token');
    expect(r2.ok && r2.value.accessToken).toBe('renewed');
  });

  it('publicación: contenedor → status FINISHED → media_publish', async () => {
    const f = fakeFetch((c) =>
      c.url.includes('/media_publish')
        ? { json: { id: 'media-1' } }
        : c.url.includes('fields=status_code')
          ? { json: { status_code: 'FINISHED' } }
          : { json: { id: 'container-1' } },
    );
    const a = createChannelAdapter('INSTAGRAM', 'LIVE', ctxOf(f.fn, { allowWrites: true }));
    const r = await a.createListing(DRAFT, 'k');
    expect(r.ok && r.value.externalId).toBe('media-1');
    expect(f.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v27.0/123456/media',
      'GET /v27.0/container-1',
      'POST /v27.0/123456/media_publish',
    ]);
    expect(new URLSearchParams(f.calls[0]?.body ?? '').get('image_url')).toBe(
      'https://cdn.example.com/a.jpg',
    );
  });

  it('editar, pausar y pedidos NO existen en la API: UNSUPPORTED (también en MOCK)', async () => {
    for (const mode of ['LIVE', 'MOCK'] as const) {
      const a = createChannelAdapter(
        'INSTAGRAM',
        mode,
        ctxOf(noNetwork().fn, { allowWrites: true }),
      );
      for (const r of [
        await a.updateListing('m', DRAFT),
        await a.pauseListing('m'),
        await a.getOrders({ limit: 1, offset: 0 }),
      ]) {
        expect(!r.ok && r.error.code).toBe('UNSUPPORTED_OPERATION');
      }
    }
  });

  it('webhook: GET de verificación devuelve el challenge; POST exige firma válida', async () => {
    const a = createChannelAdapter('INSTAGRAM', 'LIVE', ctxOf(noNetwork().fn));
    const ch = await a.handleWebhook({
      method: 'GET',
      rawBody: '',
      headers: {},
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'test-verify-token',
        'hub.challenge': '42',
      },
    });
    expect(ch.ok && ch.value).toEqual({ type: 'challenge', body: '42' });
    const wrong = await a.handleWebhook({
      method: 'GET',
      rawBody: '',
      headers: {},
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'otro', 'hub.challenge': '42' },
    });
    expect(wrong.ok && wrong.value.type).toBe('rejected');

    const body = JSON.stringify({
      object: 'instagram',
      entry: [{ id: '17841', changes: [{ field: 'comments', value: { id: 'c1', text: 'hola' } }] }],
    });
    const bad = await a.handleWebhook({
      method: 'POST',
      rawBody: body,
      headers: { 'X-Hub-Signature-256': 'sha256=00' },
      query: {},
    });
    expect(bad.ok && bad.value.type).toBe('rejected');
    const good = await a.handleWebhook({
      method: 'POST',
      rawBody: body,
      headers: { 'x-hub-signature-256': `sha256=${await hmacHex('test-webhook-secret', body)}` },
      query: {},
    });
    expect(good.ok && good.value.type === 'events' && good.value.events[0]).toMatchObject({
      topic: 'comments',
      externalAccountId: '17841',
    });
  });
});

/* ================================== WhatsApp ================================== */

describe('WhatsApp Cloud API', () => {
  it('conecta con token del sistema validándolo con GET /{phone-number-id}', async () => {
    const f = fakeFetch(() => ({
      json: {
        id: '106540352242922',
        display_phone_number: '+54 11 0000-0000',
        verified_name: 'Negocio de prueba',
        quality_rating: 'GREEN',
      },
    }));
    const a = createChannelAdapter('WHATSAPP', 'LIVE', ctxOf(f.fn, { tokens: null }));
    const r = await a.connect({
      type: 'token',
      accessToken: 'test-system-user-token',
      accountId: '106540352242922',
    });
    expect(f.calls[0]?.url).toBe('https://graph.facebook.com/v27.0/106540352242922');
    expect(f.calls[0]?.headers['authorization']).toBe('Bearer test-system-user-token');
    expect(r.ok && r.value.type === 'tokens' && r.value.tokens.expiresAt).toBeNull();
    const bad = await createChannelAdapter(
      'WHATSAPP',
      'LIVE',
      ctxOf(fakeFetch(() => ({ status: 401 })).fn),
    ).connect({
      type: 'token',
      accessToken: 'x',
      accountId: '1',
    });
    expect(!bad.ok && bad.error.code).toBe('UNAUTHORIZED');
  });

  it('no gestiona catálogo, publicaciones ni pedidos; no renueva tokens', async () => {
    const a = createChannelAdapter(
      'WHATSAPP',
      'LIVE',
      ctxOf(noNetwork().fn, { allowWrites: true }),
    );
    for (const r of [
      await a.getCatalog(),
      await a.createListing(DRAFT, 'k'),
      await a.getOrders({ limit: 1, offset: 0 }),
      await a.refreshTokens(),
    ]) {
      expect(!r.ok && r.error.code).toBe('UNSUPPORTED_OPERATION');
    }
  });

  it('webhook: mensajes y estados con idempotencia por wamid; ignora otros objetos', async () => {
    const a = createChannelAdapter('WHATSAPP', 'LIVE', ctxOf(noNetwork().fn));
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550000', phone_number_id: '106540352242922' },
                messages: [
                  {
                    from: '5491100000000',
                    from_user_id: 'AR.bsuid.1',
                    id: 'wamid.HBgL1',
                    timestamp: '1',
                    type: 'text',
                    text: { body: 'Hola' },
                  },
                ],
                statuses: [
                  {
                    id: 'wamid.OUT1',
                    status: 'delivered',
                    timestamp: '2',
                    recipient_id: '5491100000000',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const r = await a.handleWebhook({
      method: 'POST',
      rawBody: body,
      headers: { 'x-hub-signature-256': `sha256=${await hmacHex('test-webhook-secret', body)}` },
      query: {},
    });
    if (!r.ok || r.value.type !== 'events') throw new Error('x');
    expect(r.value.events.map((e) => [e.topic, e.dedupeKey, e.externalAccountId])).toEqual([
      ['messages', 'wa:msg:wamid.HBgL1', '106540352242922'],
      ['statuses', 'wa:status:wamid.OUT1:delivered', '106540352242922'],
    ]);
  });

  it('payloads documentados de texto y plantilla; envío bloqueado sin habilitación', async () => {
    expect(toWhatsAppPayload({ kind: 'text', to: '549', body: 'hola' })).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '549',
      type: 'text',
      text: { body: 'hola' },
    });
    expect(
      toWhatsAppPayload({
        kind: 'template',
        to: '549',
        name: 'pedido_listo',
        languageCode: 'es_AR',
        parameters: ['Ana'],
      }),
    ).toMatchObject({
      type: 'template',
      template: {
        name: 'pedido_listo',
        language: { code: 'es_AR' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }] }],
      },
    });
    const f = noNetwork();
    const blocked = await sendWhatsAppMessage(ctxOf(f.fn), {
      kind: 'text',
      to: '549',
      body: 'hola',
    });
    expect(!blocked.ok && blocked.error.code).toBe('COMMERCIAL_ACTIONS_DISABLED');
    expect(f.calls).toHaveLength(0);
    const sent = fakeFetch(() => ({
      json: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.X' }] },
    }));
    const r = await sendWhatsAppMessage(ctxOf(sent.fn, { allowWrites: true }), {
      kind: 'text',
      to: '549',
      body: 'hola',
    });
    expect(r.ok && r.value.wamid).toBe('wamid.X');
    expect(sent.calls[0]?.url).toBe('https://graph.facebook.com/v27.0/123456/messages');
  });
});

/* ============================ Tienda propia y afiliados ============================ */

describe('tienda propia y afiliados', () => {
  it('tienda: catálogo local, sin pedidos ni webhooks hasta configurar checkout', async () => {
    const a = createChannelAdapter('OWN_STORE', 'LIVE', ctxOf(noNetwork().fn), {
      storeCatalog: () =>
        Promise.resolve([{ externalId: 'l1', title: 'A', status: 'PUBLISHED', url: null }]),
    });
    const cat = await a.getCatalog();
    expect(cat.ok && cat.value).toHaveLength(1);
    const orders = await a.getOrders({ limit: 1, offset: 0 });
    expect(!orders.ok && orders.error.code).toBe('INTEGRATION_NOT_CONFIGURED');
    const pub = await a.createListing(DRAFT, 'k');
    expect(!pub.ok && pub.error.code).toBe('COMMERCIAL_ACTIONS_DISABLED');
  });

  it('afiliados: sin red especificada, el conector externo queda NOT_CONFIGURED', async () => {
    const a = createChannelAdapter('AFFILIATE', 'LIVE', ctxOf(noNetwork().fn));
    const st = await a.getConnectionStatus();
    expect(st.ok && st.value.status).toBe('NOT_CONFIGURED');
    const r = await a.getCatalog();
    expect(!r.ok && r.error.code).toBe('INTEGRATION_NOT_CONFIGURED');
  });
});

/* ===================================== MOCK ===================================== */

describe('modo MOCK', () => {
  const channels: ChannelKind[] = [
    'MERCADO_LIBRE',
    'INSTAGRAM',
    'WHATSAPP',
    'OWN_STORE',
    'AFFILIATE',
  ];

  it.each(channels)(
    '%s: hereda capacidades reales, nunca usa la red y marca todo como simulado',
    async (channel) => {
      const f = noNetwork();
      const live = createChannelAdapter(channel, 'LIVE', ctxOf(f.fn));
      const mock = createChannelAdapter(channel, 'MOCK', ctxOf(f.fn));
      expect(mock.mode).toBe('MOCK');
      expect(mock.capabilities).toEqual(live.capabilities);
      const st = await mock.getConnectionStatus();
      expect(st.ok && st.value.detail).toMatch(/MOCK/);
      for (const op of CHANNEL_OPERATIONS) expect(mock.capabilities[op]).toBeDefined();

      const created = await mock.createListing(DRAFT, 'idem-1');
      if (mock.capabilities.createListing.support === 'UNSUPPORTED') {
        expect(!created.ok && created.error.code).toBe('UNSUPPORTED_OPERATION');
      } else {
        expect(created.ok && created.value.externalId).toMatch(/^mock-[0-9a-f]{16}$/);
        const again = await mock.createListing(DRAFT, 'idem-1');
        expect(again.ok && created.ok && again.value.externalId).toBe(
          created.ok && created.value.externalId,
        );
      }
      const orders = await mock.getOrders({ limit: 10, offset: 0 });
      if (orders.ok) expect(orders.value).toEqual([]);
      expect(f.calls).toHaveLength(0);
    },
  );

  it('pedidos MOCK solo con fixtures explícitos (no se inventan datos)', async () => {
    const mock = createChannelAdapter('MERCADO_LIBRE', 'MOCK', ctxOf(noNetwork().fn), {
      mockFixtures: {
        orders: [
          {
            externalOrderId: 'o1',
            status: 'PAID',
            rawStatus: 'paid',
            totalCents: 100,
            currency: 'ARS',
            placedAt: null,
          },
        ],
      },
    });
    const r = await mock.getOrderStatus('o1');
    expect(r.ok && r.value.status).toBe('PAID');
    const missing = await mock.getOrderStatus('nope');
    expect(!missing.ok && missing.error.code).toBe('NOT_FOUND');
  });
});

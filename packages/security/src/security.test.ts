import { describe, expect, it } from 'vitest';
import {
  hmacSha256Hex,
  isOriginAllowed,
  parseAllowedOrigins,
  redact,
  sha256Hex,
  timingSafeEqual,
  verifyHmacSignature,
} from './index';

describe('crypto', () => {
  it('calcula sha256 conocido', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('timingSafeEqual compara correctamente', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('verifica firmas HMAC y rechaza secreto vacío', async () => {
    const sig = await hmacSha256Hex('s3cret', 'payload');
    expect(await verifyHmacSignature('s3cret', 'payload', sig)).toBe(true);
    expect(await verifyHmacSignature('otro', 'payload', sig)).toBe(false);
    expect(await verifyHmacSignature('', 'payload', sig)).toBe(false);
  });
});

describe('origins', () => {
  const allowed = parseAllowedOrigins(' http://localhost:5173/ , ,https://app.example.com');

  it('normaliza la lista', () => {
    expect(allowed).toEqual(['http://localhost:5173', 'https://app.example.com']);
  });

  it('aplica lista blanca estricta', () => {
    expect(isOriginAllowed('http://localhost:5173', allowed)).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', allowed)).toBe(false);
    expect(isOriginAllowed('null', allowed)).toBe(false);
    expect(isOriginAllowed(undefined, allowed)).toBe(false);
  });
});

describe('redact', () => {
  it('oculta claves sensibles en profundidad', () => {
    expect(redact({ email: 'a@b.c', password: 'x', nested: { apiKey: 'k', ok: 1 } })).toEqual({
      email: 'a@b.c',
      password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', ok: 1 },
    });
  });
});

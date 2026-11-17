import { describe, expect, it } from 'vitest';
import { hmacSha256Hex } from './crypto';
import {
  decryptSecret,
  encryptSecret,
  importTokenKey,
  pkceChallengeS256,
  randomToken,
  verifyMetaSignature,
} from './tokens';

// Clave de PRUEBA generada para el test (no es una credencial).
const mustKey = async (b64: string) => {
  const key = await importTokenKey(b64);
  if (!key) throw new Error('clave de prueba inválida');
  return key;
};

const TEST_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));

describe('cifrado de tokens', () => {
  it('cifra y descifra; el texto plano no aparece en lo guardado', async () => {
    const key = await mustKey(TEST_KEY);
    const stored = await encryptSecret(key, 'APP_USR-secreto', 'conn-1:access');
    expect(stored.startsWith('v1.')).toBe(true);
    expect(stored).not.toContain('secreto');
    expect(await decryptSecret(key, stored, 'conn-1:access')).toBe('APP_USR-secreto');
  });

  it('falla con otro aad (otra conexión), otra clave o formato inválido', async () => {
    const key = await mustKey(TEST_KEY);
    const other = await mustKey(btoa('x'.repeat(32)));
    const stored = await encryptSecret(key, 'tok', 'conn-1:access');
    expect(await decryptSecret(key, stored, 'conn-2:access')).toBeNull();
    expect(await decryptSecret(other, stored, 'conn-1:access')).toBeNull();
    expect(await decryptSecret(key, 'basura', 'conn-1:access')).toBeNull();
  });

  it('rechaza claves ausentes o que no miden 32 bytes', async () => {
    expect(await importTokenKey(undefined)).toBeNull();
    expect(await importTokenKey(btoa('corta'))).toBeNull();
    expect(await importTokenKey('%%%')).toBeNull();
  });

  it('IV aleatorio: dos cifrados del mismo valor difieren', async () => {
    const key = await mustKey(TEST_KEY);
    expect(await encryptSecret(key, 'a', 'x')).not.toBe(await encryptSecret(key, 'a', 'x'));
  });
});

describe('PKCE y state', () => {
  it('S256 coincide con el ejemplo del RFC 7636', async () => {
    expect(await pkceChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
  it('randomToken es base64url y único', () => {
    const a = randomToken();
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });
});

describe('firma de webhooks de Meta', () => {
  it('valida X-Hub-Signature-256 y rechaza firmas o secretos inválidos', async () => {
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const sig = `sha256=${await hmacSha256Hex('app-secret-de-prueba', body)}`;
    expect(await verifyMetaSignature('app-secret-de-prueba', body, sig)).toBe(true);
    expect(await verifyMetaSignature('app-secret-de-prueba', `${body} `, sig)).toBe(false);
    expect(await verifyMetaSignature('otro', body, sig)).toBe(false);
    expect(await verifyMetaSignature(undefined, body, sig)).toBe(false);
    expect(await verifyMetaSignature('app-secret-de-prueba', body, sig.slice(7))).toBe(false);
  });
});

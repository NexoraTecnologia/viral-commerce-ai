import { hmacSha256Hex, timingSafeEqual } from './crypto';

/**
 * Gestión segura de tokens de integraciones (Web Crypto, sin dependencias).
 *
 * - Los tokens se cifran en reposo con AES-256-GCM. La clave vive en un secret
 *   (`TOKEN_ENCRYPTION_KEY`, 32 bytes en base64) y nunca en la base de datos.
 * - El formato almacenado es `v1.<iv base64url>.<ciphertext base64url>`.
 * - `aad` (datos asociados) ata el cifrado a su conexión: un token copiado a otra
 *   fila no se puede descifrar.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const fromBase64 = (value: string): Uint8Array<ArrayBuffer> =>
  fromBase64Url(value.replace(/\+/g, '-').replace(/\//g, '_'));

/** Valida y prepara la clave maestra. Devuelve null si falta o no mide 32 bytes. */
export const importTokenKey = async (base64Key: string | undefined): Promise<CryptoKey | null> => {
  if (!base64Key) return null;
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(base64Key.trim());
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

export const encryptSecret = async (
  key: CryptoKey,
  plaintext: string,
  aad: string,
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext),
  );
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
};

/** Devuelve null si el formato es inválido, la clave no corresponde o el aad no coincide. */
export const decryptSecret = async (
  key: CryptoKey,
  stored: string,
  aad: string,
): Promise<string | null> => {
  const [version, ivPart, ctPart] = stored.split('.');
  if (version !== 'v1' || !ivPart || !ctPart) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(ivPart), additionalData: encoder.encode(aad) },
      key,
      fromBase64Url(ctPart),
    );
    return decoder.decode(pt);
  } catch {
    return null;
  }
};

/** Valor aleatorio criptográficamente seguro (state OAuth, code_verifier, códigos). */
export const randomToken = (bytes = 32): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

/** PKCE S256: code_challenge = BASE64URL(SHA256(code_verifier)) (RFC 7636). */
export const pkceChallengeS256 = async (verifier: string): Promise<string> =>
  toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));

/**
 * Valida el header `X-Hub-Signature-256: sha256=<hex>` de webhooks de Meta
 * (HMAC-SHA256 del cuerpo crudo con el App Secret).
 */
export const verifyMetaSignature = async (
  appSecret: string | undefined,
  rawBody: string,
  header: string | undefined | null,
): Promise<boolean> => {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const expected = await hmacSha256Hex(appSecret, rawBody);
  return timingSafeEqual(expected, header.slice('sha256='.length).toLowerCase());
};

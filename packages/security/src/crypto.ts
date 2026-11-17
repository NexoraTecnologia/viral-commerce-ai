/**
 * Utilidades criptográficas basadas en Web Crypto (sin dependencias, compatibles
 * con Cloudflare Workers, navegador y Node >= 20).
 */
const encoder = new TextEncoder();

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

export const sha256Hex = async (input: string): Promise<string> =>
  toHex(await crypto.subtle.digest('SHA-256', encoder.encode(input)));

export const hmacSha256Hex = async (secret: string, payload: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
};

/**
 * Comparación en tiempo constante (respecto del contenido) para firmas y tokens.
 * Evita filtrar información por timing al comparar secretos.
 */
export const timingSafeEqual = (a: string, b: string): boolean => {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const len = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
};

/** Verifica una firma HMAC-SHA256 en hex (p. ej. webhooks entrantes). */
export const verifyHmacSignature = async (
  secret: string,
  payload: string,
  signatureHex: string,
): Promise<boolean> => {
  if (secret.length === 0) return false;
  const expected = await hmacSha256Hex(secret, payload);
  return timingSafeEqual(expected, signatureHex.toLowerCase());
};

const SENSITIVE_KEY =
  /pass(word)?|secret|token|api[_-]?key|authorization|cookie|cuit|cuil|dni|card/i;

/**
 * Devuelve una copia del objeto con valores sensibles reemplazados, apta para logs.
 * Nunca loguear objetos de request/usuario sin pasar por aquí.
 */
export const redact = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return '[MaxDepth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1),
      ]),
    );
  }
  return value;
};

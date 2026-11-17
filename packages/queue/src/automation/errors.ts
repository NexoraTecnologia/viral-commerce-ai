/**
 * Clasificación de errores de trabajos:
 *  - RECOVERABLE: transitorio (red, límite de tasa, dependencia caída) → se reintenta.
 *  - PERMANENT: el trabajo nunca va a funcionar así (datos inválidos) → FAILED sin reintento.
 *  - TIMEOUT: excedió su tiempo máximo → se trata como recuperable.
 * Cualquier error desconocido se considera RECOVERABLE, acotado por el límite de intentos.
 */
export type JobErrorKind = 'RECOVERABLE' | 'PERMANENT' | 'TIMEOUT';

export class RecoverableJobError extends Error {
  override readonly name = 'RecoverableJobError';
}

export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError';
}

export class JobTimeoutError extends Error {
  override readonly name = 'JobTimeoutError';
  constructor(readonly timeoutMs: number) {
    super(`El trabajo excedió el tiempo máximo de ${timeoutMs} ms`);
  }
}

export const classifyJobError = (error: unknown): JobErrorKind => {
  if (error instanceof PermanentJobError) return 'PERMANENT';
  if (error instanceof JobTimeoutError) return 'TIMEOUT';
  return 'RECOVERABLE';
};

export const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1000);

/**
 * Ejecuta `fn` con un tiempo máximo. `sleep` se inyecta para poder testear sin
 * esperar tiempo real. Nota: en JS no se puede abortar una promesa en curso; el
 * trabajo se marca como vencido y su resultado tardío se ignora (las escrituras
 * posteriores están protegidas por el lock del trabajo).
 */
export const withTimeout = async <T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> => {
  const timer = sleep(timeoutMs).then((): never => {
    throw new JobTimeoutError(timeoutMs);
  });
  return Promise.race([fn(), timer]);
};

export interface BackoffPolicy {
  readonly baseMs: number;
  readonly factor: number;
  readonly maxMs: number;
  /** Fracción de jitter (0..1) para no reintentar todo al mismo tiempo. */
  readonly jitterRatio: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 30_000,
  factor: 2,
  maxMs: 3_600_000,
  jitterRatio: 0.2,
};

/** Hash FNV-1a de 32 bits: jitter determinístico (reproducible en tests). */
const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/**
 * Espera antes del siguiente intento (exponencial con tope y jitter determinístico).
 * `attempt` es el número de intento que acaba de fallar (1 = primero).
 */
export const computeBackoffMs = (
  attempt: number,
  seed: string,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
): number => {
  const exp = Math.min(policy.maxMs, policy.baseMs * policy.factor ** Math.max(0, attempt - 1));
  const jitterSpan = Math.floor(exp * policy.jitterRatio);
  const jitter = jitterSpan > 0 ? hash(`${seed}:${attempt}`) % jitterSpan : 0;
  return Math.min(policy.maxMs, exp + jitter);
};

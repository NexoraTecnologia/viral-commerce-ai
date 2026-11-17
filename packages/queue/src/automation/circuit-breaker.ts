/**
 * Circuit breaker por (tenant, tipo de trabajo). Corta la ejecución de un tipo de
 * trabajo que falla repetidamente para no castigar dependencias caídas ni gastar
 * cuota del plan gratuito.
 *
 * CLOSED ──(N fallas seguidas)──▶ OPEN ──(cooldown)──▶ HALF_OPEN
 *    ▲                                                   │
 *    └────────────(éxito)─────────────┘  (falla) ──▶ OPEN
 */
export type BreakerStateName = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BreakerState {
  readonly state: BreakerStateName;
  readonly consecutiveFailures: number;
  readonly openUntil: Date | null;
}

export interface BreakerPolicy {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
}

export const DEFAULT_BREAKER_POLICY: BreakerPolicy = {
  failureThreshold: 5,
  cooldownMs: 5 * 60_000,
};

export const CLOSED_BREAKER: BreakerState = {
  state: 'CLOSED',
  consecutiveFailures: 0,
  openUntil: null,
};

export type BreakerDecision =
  | { readonly allowed: true; readonly state: BreakerState }
  | { readonly allowed: false; readonly retryAt: Date; readonly state: BreakerState };

export const breakerDecision = (b: BreakerState, now: Date): BreakerDecision => {
  if (b.state !== 'OPEN') return { allowed: true, state: b };
  if (b.openUntil && now.getTime() < b.openUntil.getTime()) {
    return { allowed: false, retryAt: b.openUntil, state: b };
  }
  // Cooldown cumplido: se permite un intento de prueba.
  return { allowed: true, state: { ...b, state: 'HALF_OPEN' } };
};

export const breakerOnSuccess = (): BreakerState => CLOSED_BREAKER;

export const breakerOnFailure = (
  b: BreakerState,
  now: Date,
  policy: BreakerPolicy = DEFAULT_BREAKER_POLICY,
): BreakerState => {
  const consecutiveFailures = b.consecutiveFailures + 1;
  if (b.state === 'HALF_OPEN' || consecutiveFailures >= policy.failureThreshold) {
    return {
      state: 'OPEN',
      consecutiveFailures,
      openUntil: new Date(now.getTime() + policy.cooldownMs),
    };
  }
  return { state: 'CLOSED', consecutiveFailures, openUntil: null };
};

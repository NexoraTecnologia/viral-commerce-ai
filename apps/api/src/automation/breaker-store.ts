import { and, eq } from 'drizzle-orm';
import { circuitBreakers, type Database } from '@vc/database';
import { CLOSED_BREAKER, type BreakerState } from '@vc/queue';

export const breakerKeyForJob = (type: string): string => `job:${type}`;

export const loadBreaker = async (
  db: Database,
  tenantId: string,
  key: string,
): Promise<BreakerState> => {
  const row = await db
    .select()
    .from(circuitBreakers)
    .where(and(eq(circuitBreakers.tenantId, tenantId), eq(circuitBreakers.key, key)))
    .get();
  return row
    ? { state: row.state, consecutiveFailures: row.consecutiveFailures, openUntil: row.openUntil }
    : CLOSED_BREAKER;
};

export const saveBreaker = async (
  db: Database,
  tenantId: string,
  key: string,
  state: BreakerState,
  now: Date,
): Promise<void> => {
  const values = {
    state: state.state,
    consecutiveFailures: state.consecutiveFailures,
    openUntil: state.openUntil,
    updatedAt: now,
  };
  await db
    .insert(circuitBreakers)
    .values({ tenantId, key, ...values })
    .onConflictDoUpdate({ target: [circuitBreakers.tenantId, circuitBreakers.key], set: values });
};

import { and, eq, lte } from 'drizzle-orm';
import { locks, type Database } from '@vc/database';

/**
 * Lock con vencimiento sobre D1. La toma es atómica: INSERT … ON CONFLICT DO UPDATE
 * solo reemplaza el lock si ya venció. Si el Worker muere, el lock expira solo.
 */
export const acquireLock = async (
  db: Database,
  name: string,
  holder: string,
  now: Date,
  ttlMs: number,
): Promise<boolean> => {
  const expiresAt = new Date(now.getTime() + ttlMs);
  const rows = await db
    .insert(locks)
    .values({ name, holder, expiresAt })
    .onConflictDoUpdate({
      target: locks.name,
      set: { holder, expiresAt },
      setWhere: lte(locks.expiresAt, now),
    })
    .returning({ holder: locks.holder });
  return rows[0]?.holder === holder;
};

export const releaseLock = async (db: Database, name: string, holder: string): Promise<void> => {
  await db.delete(locks).where(and(eq(locks.name, name), eq(locks.holder, holder)));
};

/** Ejecuta `fn` solo si se obtiene el lock; lo libera siempre. */
export const withLock = async <T>(
  db: Database,
  name: string,
  holder: string,
  now: Date,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> => {
  if (!(await acquireLock(db, name, holder, now, ttlMs))) return { acquired: false };
  try {
    return { acquired: true, value: await fn() };
  } finally {
    await releaseLock(db, name, holder);
  }
};

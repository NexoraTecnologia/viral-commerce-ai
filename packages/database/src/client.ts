import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

/** Tipo mínimo del binding D1 para no acoplar este paquete a @cloudflare/workers-types. */
export type D1Binding = Parameters<typeof drizzle>[0];

export const createDb = (d1: D1Binding) => drizzle(d1, { schema });
export type Database = ReturnType<typeof createDb>;

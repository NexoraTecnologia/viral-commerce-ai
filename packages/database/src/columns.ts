import { sql } from 'drizzle-orm';
import { integer } from 'drizzle-orm/sqlite-core';

export const epochMsDefault = sql`(unixepoch('subsec') * 1000)`;

export const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(epochMsDefault),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(epochMsDefault),
};

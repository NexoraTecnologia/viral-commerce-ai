import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { auditEvents, tenants, users } from './schema';

describe('schema', () => {
  it('usa nombres de tabla snake_case', () => {
    expect([tenants, users, auditEvents].map((t) => getTableConfig(t).name)).toEqual([
      'tenants',
      'users',
      'audit_events',
    ]);
  });

  it('todas las tablas multi-tenant tienen tenant_id', () => {
    for (const table of [users, auditEvents]) {
      expect(getTableConfig(table).columns.map((c) => c.name)).toContain('tenant_id');
    }
  });
});

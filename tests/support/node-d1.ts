import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

/**
 * Adaptador mínimo de la API de D1 sobre `node:sqlite` (SQLite real, en memoria)
 * para tests de integración sin Cloudflare ni red. Implementa solo lo que usa
 * Drizzle: prepare/bind/all/raw/run/first y batch.
 */
type Param = SQLInputValue | boolean | undefined;

const toSqlite = (v: Param): SQLInputValue =>
  v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;

class NodeD1PreparedStatement {
  constructor(
    private readonly stmt: StatementSync,
    private readonly params: SQLInputValue[] = [],
  ) {}

  bind(...values: Param[]): NodeD1PreparedStatement {
    return new NodeD1PreparedStatement(this.stmt, values.map(toSqlite));
  }

  all() {
    this.stmt.setReturnArrays(false);
    const results = this.stmt.all(...this.params);
    return Promise.resolve({ results, success: true, meta: {} });
  }

  raw() {
    this.stmt.setReturnArrays(true);
    const rows = this.stmt.all(...this.params);
    this.stmt.setReturnArrays(false);
    return Promise.resolve(rows);
  }

  first() {
    this.stmt.setReturnArrays(false);
    return Promise.resolve(this.stmt.get(...this.params) ?? null);
  }

  run() {
    // Sentencias con RETURNING devuelven filas incluso vía run().
    if (/\breturning\b/i.test(this.stmt.sourceSQL)) return this.all();
    const r = this.stmt.run(...this.params);
    return Promise.resolve({
      results: [],
      success: true,
      meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) },
    });
  }
}

export class NodeD1Database {
  readonly sqlite: DatabaseSync;

  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
  }

  prepare(sql: string): NodeD1PreparedStatement {
    return new NodeD1PreparedStatement(this.sqlite.prepare(sql));
  }

  /** Atómico como D1: todo o nada. */
  async batch(statements: NodeD1PreparedStatement[]) {
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const s of statements) results.push(await s.all());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  exec(sql: string) {
    this.sqlite.exec(sql);
    return Promise.resolve({ count: 0, duration: 0 });
  }
}

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'packages', 'database', 'migrations');

/** Crea una base en memoria con todas las migraciones reales aplicadas. */
export const createTestD1 = (): NodeD1Database => {
  const db = new NodeD1Database();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.sqlite.exec(statement);
    }
  }
  return db;
};

import { defineConfig } from 'drizzle-kit';

/**
 * Solo se usa para GENERAR migraciones SQL a partir de src/schema.ts.
 * La aplicación de migraciones la hace Wrangler (`wrangler d1 migrations apply`),
 * por eso no se configuran credenciales aquí.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});

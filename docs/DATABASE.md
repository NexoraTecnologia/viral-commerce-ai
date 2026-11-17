# Base de datos

**Motor:** Cloudflare D1 (SQLite). **ORM:** Drizzle. **Migraciones:** SQL generado
por `drizzle-kit`, aplicado por Wrangler.

## Ubicación

| Archivo                               | Contenido                               |
| ------------------------------------- | --------------------------------------- |
| `packages/database/src/schema.ts`     | Esquema (fuente de verdad)              |
| `packages/database/src/client.ts`     | `createDb(env.DB)` → cliente Drizzle    |
| `packages/database/migrations/*.sql`  | Migraciones generadas (commitear)       |
| `packages/database/drizzle.config.ts` | Config de generación (sin credenciales) |

## Convenciones

- Tablas y columnas en `snake_case`; propiedades TS en `camelCase`.
- PK `id` de tipo `TEXT` con UUID generado en la app (`newId()`).
- `created_at` / `updated_at` como `INTEGER` epoch en milisegundos.
- Toda tabla de dominio multi-tenant lleva `tenant_id NOT NULL` con FK e índice.
- Dinero en `INTEGER` (centavos) + columna `currency`. Nunca `REAL`.
- Enumeraciones como `TEXT` con `enum` de Drizzle (validado también con Zod).
- JSON en `TEXT` (`mode: 'json'`), siempre ya redactado.
- `audit_events` es append-only: nunca `UPDATE` ni `DELETE` desde la app.

## Tablas actuales

| Tabla          | Propósito                                                   |
| -------------- | ----------------------------------------------------------- |
| `tenants`      | Cuentas cliente del SaaS (`slug` único)                     |
| `users`        | Usuarios por tenant, rol `owner/admin/operator/viewer`      |
| `audit_events` | Registro inmutable de acciones; `dry_run` indica simulación |

## Flujo de cambios

```bash
npm run db:generate
```

Revisar el SQL generado en `packages/database/migrations/`, luego:

```bash
npm run db:migrate:local
```

Reglas: nunca editar una migración ya aplicada; cambios destructivos (drop/rename)
requieren plan de migración de datos y aprobación explícita.

## Límites del plan Free

D1 Free tiene límites de almacenamiento y de filas leídas/escritas por día.
Consultar los valores vigentes en la documentación oficial de Cloudflare antes de
diseñar cargas grandes; preferir índices adecuados y paginación siempre.

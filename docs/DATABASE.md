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

| Tabla                     | Propósito                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `tenants`                 | Cuentas cliente del SaaS (`slug` único)                                                              |
| `users`                   | Usuarios por tenant, rol `owner/admin/operator/viewer`                                               |
| `audit_events`            | Registro inmutable de acciones; `dry_run` indica simulación                                          |
| `suppliers`               | Proveedores: datos comerciales, ubicación, contactos, despacho, devoluciones, pago, estado y puntaje |
| `supplier_evidence`       | Evidencia de verificación (PENDING → ACCEPTED/REJECTED, vencimiento)                                 |
| `supplier_status_history` | Historial de verificación (append-only)                                                              |
| `supplier_products`       | Catálogo del proveedor con precio mayorista, fecha y origen del precio                               |
| `supplier_inventory`      | Controles de stock (histórico; vigente = último `checked_at`)                                        |
| `products`                | Productos propios con precio de venta                                                                |
| `product_costs`           | Componentes de costo por producto (fijo y/o % sobre precio)                                          |
| `profit_calculations`     | Resultado de cada cálculo + foto de los datos usados (append-only)                                   |

| `job_schedules` | Programaciones de agentes (frecuencia, zona horaria, próxima ejecución) |
| `jobs` | Trabajos: estado, prioridad, idempotencia, lock/lease, intentos, resultado |
| `job_attempts` | Historial de intentos (resultado, error, duración) |
| `circuit_breakers` | Estado por tenant y tipo de trabajo |
| `locks` | Locks globales con vencimiento (Scheduler, Recovery) |

| Discovery (10 tablas) | Fuentes, categorías, competidores, productos detectados, observaciones, atributos, imágenes, análisis y contenido — ver DISCOVERY_CONTENT.md |
| Canales (8 tablas) | `channel_connections` (tokens cifrados), `oauth_states`, `channel_listings`, `channel_orders`, `channel_messages`, `webhook_events` (idempotencia), `integration_logs`, `rate_limit_windows` — ver CHANNELS.md |
| Pedidos (12 tablas) | `orders`, `order_items`, `order_payments` (evidencia, idempotencia), `supplier_orders`, `shipments`, `order_returns`, `order_ledger_entries`, `order_events` (append-only), `funds_snapshots`, `support_tickets`, `support_messages`, `faq_entries` — ver ORDERS.md |
| Gobierno (1 tabla) | `rule_change_requests`: propuestas de cambio de reglas (nunca se aplican desde el frontend) |
| Afiliados (5 tablas) | `affiliate_networks`, `affiliate_products`, `affiliate_links`, `affiliate_clicks` (sin IP), `affiliate_conversions` |

Detalle de reglas: [SUPPLIER_PROFIT_ENGINES.md](SUPPLIER_PROFIT_ENGINES.md), [AUTOMATION.md](AUTOMATION.md), [DISCOVERY_CONTENT.md](DISCOVERY_CONTENT.md) y [CHANNELS.md](CHANNELS.md).

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

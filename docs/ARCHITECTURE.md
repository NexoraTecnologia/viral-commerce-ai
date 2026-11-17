# Arquitectura

## Estilo: monolito modular cloud-first

Un único repositorio y un único Worker de API, divididos internamente en
paquetes con límites explícitos. Permite moverse rápido con costo cero y, si un
módulo lo justifica, extraerlo después a su propio Worker sin reescribirlo.

```
                 ┌──────────────────────┐
  Navegador ───▶ │  apps/dashboard      │  React + Vite (estático)
                 └─────────┬────────────┘
                           │ HTTPS /api/*  (contratos Zod de @vc/shared)
                 ┌─────────▼────────────┐
                 │  apps/api            │  Cloudflare Worker (Hono)
                 │  fetch()  queue()    │
                 └──┬──────────┬────────┘
                    │          │
        ┌───────────▼──┐   ┌───▼──────────────────┐
        │  D1 (SQLite) │   │  Queues + DLQ        │
        │  binding DB  │   │  binding JOBS_QUEUE  │
        └──────────────┘   └──────────────────────┘
```

## Módulos

| Ruta                      | Responsabilidad                                                             | Depende de         |
| ------------------------- | --------------------------------------------------------------------------- | ------------------ |
| `apps/dashboard`          | UI de operación. Solo habla con la API.                                     | shared             |
| `apps/api`                | Borde HTTP y consumidor de colas. Composición; sin lógica de negocio.       | todos los paquetes |
| `packages/shared`         | Tipos y contratos transversales: `Result`, `Money`, config, contratos HTTP. | —                  |
| `packages/security`       | Criptografía (Web Crypto), firmas HMAC, CORS, redacción de logs.            | —                  |
| `packages/business-rules` | Reglas puras: precios/márgenes, guardia de acciones comerciales.            | shared             |
| `packages/integrations`   | Contratos de proveedores externos + registro. Sin integraciones reales aún. | shared             |
| `packages/queue`          | Esquemas de mensajes (Zod, versionados) y dispatcher tipado.                | shared             |
| `packages/database`       | Esquema Drizzle, cliente D1, migraciones SQL.                               | shared             |
| `infrastructure/`         | Documentación y scripts de recursos Cloudflare.                             | —                  |
| `tests/`                  | Pruebas de integración y de arquitectura entre módulos.                     | —                  |
| `docs/`                   | Documentación técnica y especificaciones (`docs/specs/`).                   | —                  |

Los paquetes exportan su código fuente TypeScript (`exports: ./src/index.ts`);
Wrangler (esbuild) y Vite compilan en el bundle de cada app. No hay paso de
build por paquete.

## Decisiones (ADR resumidas)

1. **Hono** como router del Worker: liviano, tipado, nativo de Workers, sin costo.
2. **npm workspaces** (no pnpm/turbo): cero herramientas adicionales que instalar.
3. **Drizzle + migraciones SQL generadas** aplicadas por Wrangler: D1 nativo, SQL revisable.
4. **Zod en todos los bordes**: el contrato HTTP se comparte entre API y dashboard.
5. **Interruptor `COMMERCIAL_ACTIONS_ENABLED`** (default `false`): el sistema nace en
   modo simulación; cualquier efecto comercial real es opt-in explícito.
6. **Colas con sobre versionado** (`type`, `schemaVersion`, `id`, `createdAt`):
   mensajes inválidos se descartan (ack + log), fallos transitorios se reintentan,
   y tras `max_retries` van a la DLQ.

## Flujo de una petición

1. `secureHeaders` → `cors` (lista blanca estricta desde `ALLOWED_ORIGINS`).
2. Ruta Hono valida entrada con Zod.
3. Lógica en `business-rules`; persistencia vía `database`; trabajo lento → `queue`.
4. Errores: formato estándar `{ error: { code, message } }`, sin detalles internos.

## Módulos de dominio en la API

`apps/api/src/modules/{tenants,suppliers,catalog,profit}`: cada módulo tiene
`service.ts` (consultas Drizzle filtradas por tenant + llamada a reglas puras) y
`routes.ts` (validación Zod y respuesta HTTP). Reglas en `packages/business-rules`;
contratos en `packages/shared/src/domain`. Ver `docs/SUPPLIER_PROFIT_ENGINES.md`.

## Pendiente de especificación

Autenticación, dominio de productos/proveedores/pedidos/afiliados, integraciones
concretas e impuestos argentinos. Ver `docs/ROADMAP.md`.

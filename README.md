# ViralCommerce AI — Argentina

Plataforma SaaS de dropshipping y afiliación automatizada, sin inventario propio.
Monolito modular sobre Cloudflare (Free), escrito en TypeScript.

> Etapa actual: **Fundación**. Base compilable y documentada; sin integraciones
> reales, sin despliegue y con acciones comerciales bloqueadas (modo simulación).

## Requisitos

- Node.js ≥ 22 (recomendado 24, ver `.nvmrc`)
- npm ≥ 10
- No se necesita cuenta de Cloudflare para desarrollo local.

## Inicio rápido

```bash
npm install
```

```bash
npm run db:migrate:local
```

En dos terminales:

```bash
npm run dev:api
```

```bash
npm run dev:dashboard
```

- API: http://localhost:8787/health
- Dashboard: http://localhost:5173 (usa el proxy `/api` → `:8787`)

## Scripts

| Script                     | Descripción                                             |
| -------------------------- | ------------------------------------------------------- |
| `npm run check`            | Format + lint + typecheck + tests + build               |
| `npm test`                 | Tests con Vitest                                        |
| `npm run lint`             | ESLint (typescript-eslint strict type-checked)          |
| `npm run typecheck`        | `tsc` en todos los workspaces                           |
| `npm run format`           | Prettier                                                |
| `npm run build`            | Build del dashboard y dry-run del Worker (no despliega) |
| `npm run db:generate`      | Genera migración SQL desde el esquema Drizzle           |
| `npm run db:migrate:local` | Aplica migraciones a la D1 local (Miniflare)            |

## Estructura

```
apps/
  api/                 Worker de Cloudflare (Hono): HTTP + consumidor de Queues
  dashboard/           React + Vite
packages/
  shared/              Result, Money, config, contratos HTTP (Zod)
  security/            Web Crypto, HMAC, CORS, redacción de logs
  business-rules/      Pricing y guardia de acciones comerciales
  integrations/        Contratos de proveedores (sin integraciones reales)
  queue/               Mensajes versionados y dispatcher
  database/            Esquema Drizzle + migraciones D1
infrastructure/        Recursos Cloudflare (documentación / setup)
tests/                 Pruebas de integración y arquitectura
docs/                  Arquitectura, roadmap, base de datos, despliegue, specs
data/  scripts/        Datos locales (ignorados) y scripts auxiliares
```

## Documentación

- [CLAUDE.md](CLAUDE.md) — reglas permanentes del proyecto
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/ROADMAP.md](docs/ROADMAP.md)
- [docs/DATABASE.md](docs/DATABASE.md)
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- [docs/SUPPLIER_PROFIT_ENGINES.md](docs/SUPPLIER_PROFIT_ENGINES.md) — proveedores, rentabilidad y Financial Guard
- [docs/AUTOMATION.md](docs/AUTOMATION.md) — Scheduler, colas, reintentos y recuperación
- [docs/DISCOVERY_CONTENT.md](docs/DISCOVERY_CONTENT.md) — investigación, puntuación, Risk Guardian y contenido
- [SECURITY.md](SECURITY.md)
- [docs/specs/](docs/specs/) — especificaciones funcionales

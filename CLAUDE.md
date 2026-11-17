# CLAUDE.md — Reglas permanentes de ViralCommerce AI

Este archivo es la fuente de verdad para cualquier sesión de Claude Code en este
repositorio. Leerlo completo antes de modificar código.

## Producto

ViralCommerce AI Argentina: plataforma SaaS de dropshipping y afiliación
automatizada, **sin inventario propio**. Mercado inicial: Argentina (ARS, es-AR).

Las especificaciones funcionales viven en `docs/specs/`. Si una tarea no está
especificada ahí, **preguntar antes de inventar comportamiento**.

## Restricciones no negociables

1. **Presupuesto USD 0.** Solo servicios gratuitos (Cloudflare Free, GitHub Free).
   No agregar dependencias ni servicios con costo sin aprobación explícita.
2. **Sin Claude API (ni otros LLM de pago) en producción** en esta etapa.
3. **No inventar integraciones.** Una integración externa existe solo si está
   especificada y tiene documentación oficial verificada. Hasta entonces: solo
   contratos en `packages/integrations`.
4. **No crear credenciales falsas** ni commitear secretos. Secretos → `wrangler secret put`
   o `.dev.vars` (ignorado por git).
5. **No desplegar** sin pedido explícito del usuario (ver `docs/DEPLOYMENT.md`).
6. **No ejecutar acciones comerciales reales** (publicar, comprar, cobrar, reembolsar,
   contactar clientes/proveedores). Toda acción comercial pasa por
   `assertCommercialActionAllowed` (`packages/business-rules`) y
   `COMMERCIAL_ACTIONS_ENABLED` permanece en `false`.
7. **No eliminar archivos útiles.** Ante la duda, preguntar.

## Stack

TypeScript estricto · React + Vite · Cloudflare Workers (Hono) · D1 · Queues ·
Drizzle ORM · Zod · Vitest · ESLint + Prettier · npm workspaces.

## Arquitectura (resumen — detalle en docs/ARCHITECTURE.md)

Monolito modular. Dirección de dependencias permitida:

```
apps/*  →  packages/{business-rules, integrations, queue, database, security}  →  packages/shared
```

- `packages/shared` no depende de ningún paquete interno.
- Ningún paquete depende de `apps/*`.
- `apps/dashboard` solo puede importar `@vc/shared` (nunca database/queue/integrations).
- Lógica de negocio pura en `packages/business-rules` (sin I/O, testeable).
- Estas reglas están protegidas por `tests/integration/architecture.test.ts`.

## Convenciones de código

- Dinero **siempre** en centavos enteros (`Money`), porcentajes en basis points.
- Validar con Zod en todos los bordes: HTTP, colas, integraciones, variables de entorno.
- Errores esperados → `Result<T, AppError>`; excepciones solo para lo inesperado.
- Tablas multi-tenant llevan `tenant_id`; toda query de dominio filtra por tenant.
- Nada de `any`. Imports de tipos con `import type`.
- Logs sin datos sensibles: usar `redact()` de `@vc/security`.
- Código y comentarios técnicos en español o inglés, pero consistente por archivo;
  textos de UI en español rioplatense neutro.

## Flujo de trabajo

- Antes de terminar cualquier cambio: `npm run check` (format, lint, typecheck, test, build).
- Cambios de esquema: editar `packages/database/src/schema.ts` → `npm run db:generate` →
  revisar el SQL generado → `npm run db:migrate:local`. Nunca editar migraciones ya aplicadas.
- Cada módulo nuevo trae tests. Cada regla de negocio trae tests de bordes.
- Commits pequeños y descriptivos. No hacer push ni PR sin pedido del usuario.

## Comandos

| Comando                    | Qué hace                              |
| -------------------------- | ------------------------------------- |
| `npm run dev:api`          | Worker local en http://localhost:8787 |
| `npm run dev:dashboard`    | Dashboard en http://localhost:5173    |
| `npm run check`            | Verificación completa                 |
| `npm test`                 | Tests (Vitest)                        |
| `npm run db:generate`      | Genera migración SQL desde el esquema |
| `npm run db:migrate:local` | Aplica migraciones a la D1 local      |

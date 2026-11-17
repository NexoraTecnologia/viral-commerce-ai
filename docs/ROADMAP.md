# Roadmap

Fases incrementales. Cada fase termina con `npm run check` en verde y documentación
actualizada. El contenido de las fases 2+ se ajustará a las especificaciones
funcionales en `docs/specs/`.

## Fase 0 — Fundación ✅ (actual)

- [x] Monorepo con npm workspaces y TypeScript estricto
- [x] ESLint (strict type-checked) + Prettier + Vitest
- [x] Worker API (Hono) con `/health`, cabeceras seguras, CORS estricto
- [x] Consumidor de Queues con mensajes validados y DLQ configurada
- [x] Esquema D1 base (tenants, users, audit_events) + migración inicial
- [x] Dashboard React + Vite con chequeo de salud de la API
- [x] Guardia de acciones comerciales (modo simulación por defecto)
- [x] Documentación base

## Fase 0.5 — Supplier Engine + Profit Engine ✅

- [x] Registro de proveedores, evidencia, estados, puntaje e historial de verificación
- [x] Catálogo, precio mayorista y controles de stock del proveedor
- [x] Cálculo económico puro con umbral de margen configurable (20 %)
- [x] Viabilidad de producto (proveedor, stock, precio, moneda, margen)
- [x] Financial Guard (fondos, liquidación, vencimientos, devoluciones, financiación)
- [x] Dashboard: Proveedores, Productos, Stock, Rentabilidad
- [x] Tests de reglas puras + integración HTTP→SQLite real

## Fase 1 — Especificaciones y CI

- [ ] Incorporar especificaciones funcionales en `docs/specs/`
- [ ] Crear repositorio en GitHub y CI gratuita (GitHub Actions: `npm run check`)
- [ ] Definir modelo de dominio inicial a partir de las specs

## Fase 2 — Identidad y multi-tenant

- [ ] Autenticación (método a definir; preferir solución sin costo)
- [ ] Middleware de tenant y autorización por rol
- [ ] Auditoría de acciones en `audit_events`

## Fase 3 — Catálogo (modo simulación)

- [ ] Modelo de productos, proveedores y precios
- [ ] Reglas de pricing ARS (incluyendo impuestos cuando estén especificados)
- [ ] Primera integración **real de solo lectura**, con documentación oficial verificada

## Fase 4 — Automatización

- [ ] Trabajos programados (Cron Triggers) y pipelines en Queues
- [ ] Afiliación: generación y seguimiento de enlaces

## Fase 5 — Primer despliegue (staging)

- [ ] Crear recursos Cloudflare (ver `infrastructure/cloudflare/setup.md`)
- [ ] Desplegar staging con `COMMERCIAL_ACTIONS_ENABLED=false`

## Fase 6 — Operación comercial controlada

- [ ] Revisión legal/fiscal argentina
- [ ] Habilitar acciones comerciales por tenant, con límites y auditoría

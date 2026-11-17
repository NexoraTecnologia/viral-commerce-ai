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

## Fase 0.6 — Automation Core ✅

- [x] Orchestrator, Scheduler central, Producer/Consumer, Job Manager, Retry Manager, Audit Logger
- [x] 2 Cron Triggers (Scheduler y Recovery Worker); frecuencias en D1 editables desde el dashboard
- [x] Hora Argentina (zona IANA en servidor, sin depender del navegador)
- [x] Locks, idempotencia, timeouts, circuit breakers, DLQ y recuperación desde D1

## Fase 0.7 — Discovery + Content Engine ✅

- [x] Fuentes con adaptadores intercambiables (NOT_CONFIGURED sin conector real)
- [x] Productos detectados, categorías, competidores, demanda y precios con fuente y fecha
- [x] Tendencias, saturación, oportunidades y Product Scoring 0–100 con confianza
- [x] Risk Guardian obligatorio (la puntuación no lo saltea)
- [x] Content Engine con plantillas propias y control de afirmaciones
- [ ] Especificar Risk Guardian completo (hoy reutiliza los controles existentes)

## Fase 0.8 — Integraciones omnicanal ✅

- [x] Adaptadores independientes: Mercado Libre, Instagram, WhatsApp Cloud API, tienda propia, afiliados
- [x] Capacidades según la API oficial (lo no soportado no se simula) y modo MOCK por canal
- [x] OAuth (state + PKCE), tokens cifrados, renovación, webhooks con firma, idempotencia, logs, rate limiting
- [x] Publicación automática solo con todas las condiciones (gate) y Commercial Guard
- [x] Tienda propia con checkout separado (no configurado; sin pagos simulados)
- [x] Afiliados: redes, productos, enlaces, clics, conversiones y comisiones con respaldo
- [ ] Especificar pasarela de checkout, redes de afiliados concretas y carruseles de Instagram
- [ ] Crear apps reales (Mercado Libre / Meta) y cargar secrets antes de cualquier prueba LIVE

## Fase 0.9 — Order + Fulfillment Engine ✅

- [x] Estados del pedido y bloqueos con requisitos de evidencia por estado
- [x] Pago solo con evidencia del canal de pago; idempotente
- [x] Stock verificado, selección de proveedor y validación financiera (Financial Guard + reservas)
- [x] Despacho (bloqueado sin interruptor), confirmación, transportista, seguimiento y entrega
- [x] Cancelaciones, devoluciones, reintegros con evidencia y conciliación económica
- [x] Atención al cliente: consultas, FAQ, estado, plantillas veraces y escalamiento
- [x] 7 simulaciones con las mismas reglas, sin efectos
- [ ] Especificar división de pedidos entre proveedores y líneas de financiación

## Fase 0.10 — Command Center UI ✅

- [x] Dashboard oscuro (violeta/azul), sidebar compacta con 17 secciones y versión móvil
- [x] Overview con KPIs reales y uso del plan gratuito (lo no medido se informa como tal)
- [x] Envíos, Clientes, Finanzas, Agentes, Reglas, Auditoría y Configuración
- [x] Estados LOADING / EMPTY / ERROR / SUCCESS; búsqueda, filtros y paginación
- [x] Reglas: solo propuestas; aplicarlas requiere autorización del titular
- [ ] Medir solicitudes de Workers y filas de D1 (API de analíticas de Cloudflare)

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

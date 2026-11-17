# Command Center (dashboard)

Es el dashboard definitivo de **VIRALCOMMERCE AI · ARGENTINA**, hecho en React + Vite y
desplegable en Cloudflare Pages Free.

## Diseño

- **Tema oscuro.** Acentos violeta y azul (degradado), verde para lo positivo y rojo para
  los bloqueos. Los tokens están en `apps/dashboard/src/styles.css` (`:root`).
- **Sidebar compacta** con 17 secciones agrupadas (General, Producto, Ventas, Control) e
  íconos SVG propios, sin dependencias.
- **Responsive:**
  - Por debajo de 1100 px, los paneles divididos pasan a una columna.
  - Por debajo de 900 px, la sidebar se vuelve un menú lateral con botón (se cierra con
    Escape, con un toque fuera o al navegar).
  - Por debajo de 640 px, los KPI van en dos columnas, los formularios a ancho completo y
    las tablas con scroll horizontal.
- **Accesibilidad:** foco visible, `aria-current` en la navegación, `aria-live` en las
  notificaciones y animaciones desactivables con `prefers-reduced-motion`.

## Menú → contenido

| Menú                      | Contenido                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| Overview                  | KPIs reales (`GET /v1/command/overview`) y uso del plan gratuito                             |
| Radar de productos        | Discovery: radar, investigados, candidatos, descartados, contenido, fuentes                  |
| Catálogo                  | Productos, costos y ofertas (formulario **agregar producto**)                                |
| Proveedores               | Alta (**agregar proveedor**), evidencia, verificación                                        |
| Inventario de proveedores | Precios y controles de stock                                                                 |
| Publicaciones             | **Revisar publicaciones**: condiciones de publicación (gate), publicar/pausar, vista previa  |
| Pedidos                   | **Consultar pedidos**, detalle con acciones por estado, pedidos de canales, simulaciones     |
| Envíos                    | `GET /v1/command/shipments`: seguimiento, vencidos sin entrega                               |
| Clientes                  | Compradores (`/command/customers`), atención al cliente, mensajes de canales                 |
| Afiliados                 | Redes, productos, enlaces, conversiones y comisiones                                         |
| Finanzas                  | Ventas y beneficio reales, fondos, rentabilidad y Financial Guard                            |
| Automatizaciones          | Programaciones, cola, reintentos y circuit breakers                                          |
| Agentes                   | Tipos de trabajo, última ejecución y "Ejecutar ahora" (solo los que no requieren parámetros) |
| Integraciones             | **Configurar canales** (LIVE/MOCK, OAuth, token), registro y webhooks                        |
| Reglas                    | Reglas vigentes y formulario **modificar reglas** (propuesta)                                |
| Auditoría                 | Eventos del sistema y de pedidos, con paginación en el servidor                              |
| Configuración             | Espacio, entorno, interruptor comercial y presencia de secrets                               |

Los enlaces viejos (`#productos`, `#canales`, etc.) redirigen a la sección nueva.

## Datos reales, nunca ficticios

- **Origen:** cada tabla usa datos del backend o muestra un estado vacío. Ningún KPI usa
  valores de ejemplo; si no hay datos, se muestra `—`.
- **Ventas reales:** cobros aprobados con evidencia, netos de los reembolsos con evidencia.
- **Beneficio neto:** solo se cuenta el de los pedidos **SETTLED** (conciliados con
  comprobantes).
- **Publicaciones activas:** solo las LIVE. Las MOCK se informan aparte como simuladas.
- **Uso de recursos gratuitos:** los límites vienen de developers.cloudflare.com
  (consultado el 2026-11-17).
  - Queues: estimación propia de 3 operaciones por intento de trabajo registrado hoy.
  - Cron Triggers: 2 de 5.
  - Solicitudes de Workers y filas de D1: **no medido**, porque requiere la API de
    analíticas de Cloudflare. No se estima.

## Estados

Componentes en `apps/dashboard/src/ui.tsx`:

- **LOADING:** esqueleto animado (`Loading`).
- **EMPTY:** `EmptyState` o `Empty`, con una explicación de qué hace falta.
- **ERROR:** `ErrorState`, con botón **Reintentar**.
- **SUCCESS:** notificación (`ToastStack`). `useAction` la muestra después de cada acción
  y también notifica los errores. Las acciones de solo lectura (vista previa, simulación)
  no muestran "guardado".

## Búsqueda, filtros y paginación

- **En el cliente:** `useListControls` + `ListToolbar` + `ControlsPager` se usan en
  Pedidos, Publicaciones, Proveedores, Catálogo, Envíos, Clientes y Agentes.
- **En el servidor:** Auditoría, porque puede crecer mucho (`page`, `pageSize` ≤ 100 y
  `q`).

## Reglas financieras

El frontend **no modifica reglas**. El formulario de Reglas registra una propuesta
(`rule_change_requests`, estado `PENDING_AUTHORIZATION`) y un evento de auditoría.

Las reglas viven en variables de entorno del Worker. Cambiarlas requiere autorización del
titular: editar `apps/api/wrangler.jsonc` y desplegar. Más adelante, la aprobación con rol
owner llegará con la Fase 2 de identidad.

Las reglas financieras se marcan como "requiere autorización".

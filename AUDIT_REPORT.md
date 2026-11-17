# AUDIT_REPORT — ViralCommerce AI

- **Fecha:** 2026-11-17
- **Alcance:** todo el monorepo (`apps/api`, `apps/dashboard`, `packages/*`, migraciones D1,
  `tests/`).
- **Método:** verificación automática (compilación, tipos, lint y tests), revisión de
  código, 21 pruebas negativas nuevas (A–J más controles adicionales), medición de
  consultas D1 por solicitud y verificación manual en el navegador.
- **Restricción respetada:** no se agregaron funcionalidades. Solo se corrigieron fallas
  encontradas por la auditoría.

## Veredicto

> ❌ **NO apto para producción.** Hay un fallo crítico abierto: **no existe autenticación
> real**. Además, el motor de pedidos **supera el límite de consultas D1 del plan Free**.
>
> Lo positivo:
>
> - Los **controles financieros y comerciales funcionan y fallan de forma segura**.
> - Ninguna acción comercial real puede ejecutarse con `COMMERCIAL_ACTIONS_ENABLED=false`.
> - Las 10 pruebas negativas obligatorias pasan.
> - Se corrigieron 6 fallas, una de ellas crítica.

| Severidad | Abiertos | Corregidos |
| --------- | -------- | ---------- |
| Crítica   | 1        | 1          |
| Alta      | 3        | 2          |
| Media     | 6        | 3          |
| Baja      | 4        | 0          |

---

## 1. Verificaciones (22 puntos)

| #   | Verificación              | Resultado              | Evidencia                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Compilación               | ✅ OK                  | `npm run check` → build del dashboard (Vite) y del Worker (`wrangler deploy --dry-run`)                                                                                                                                                                                                                                              |
| 2   | TypeScript                | ✅ OK                  | `tsc` estricto en 9 proyectos (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), 0 errores                                                                                                                                                                                                                                  |
| 3   | Lint                      | ✅ OK                  | ESLint (typescript-eslint strictTypeChecked), 0 errores. Prettier, 0 diferencias                                                                                                                                                                                                                                                     |
| 4   | Tests unitarios           | ✅ OK                  | 215 tests (reglas puras, adaptadores, seguridad)                                                                                                                                                                                                                                                                                     |
| 5   | Tests de integración      | ✅ OK                  | 122 tests: HTTP → servicios → SQLite real, sin red. **Total: 337/337, 27 archivos**                                                                                                                                                                                                                                                  |
| 6   | Migraciones D1            | ✅ OK                  | 7 migraciones (0000–0006) sin DROP ni ALTER destructivos. `drizzle-kit check`: "Everything's fine". `db:generate`: "No schema changes". Todas se aplican desde cero en cada test y en la D1 local                                                                                                                                    |
| 7   | Autenticación             | ❌ **CRÍTICO**         | No hay autenticación de usuarios. El header `X-Tenant-Id` es un mecanismo temporal de desarrollo. Ver V-01 y V-02                                                                                                                                                                                                                    |
| 8   | Autorización              | ⚠️ Parcial             | Aislamiento por tenant correcto (otro tenant: 404, tenant inexistente: 401). **No hay roles**: cualquier usuario del espacio puede registrar fondos, resolver revisiones, etc. (V-03)                                                                                                                                                |
| 9   | Protección de secretos    | ✅ OK                  | Sin secretos en el repo ni en el historial de git. `.dev.vars` y `.env` ignorados. Tokens cifrados AES-256-GCM con AAD por conexión. La API nunca devuelve tokens. Configuración muestra solo presencia. Logs sin secretos (se revisaron todos los `console.*`); las URLs con `access_token` se truncan antes del `?` en los errores |
| 10  | Webhooks                  | ✅ OK con riesgos      | Meta: HMAC `X-Hub-Signature-256` en tiempo constante; GET de verificación con verify token. Mercado Libre (sin firma, según su documentación): `application_id` + re-consulta del recurso. Idempotencia por `(canal, dedupe_key)`. Límite de 3 MB. Riesgo: sin rate limiting en rutas públicas (R-04)                                |
| 11  | Scheduler                 | ✅ OK                  | Tests del Automation Core: materialización idempotente, lock, misfire, hora de Argentina                                                                                                                                                                                                                                             |
| 12  | Queues                    | ✅ OK                  | Los mensajes son punteros; D1 es la fuente de verdad; DLQ marca `DEAD_LETTER`; prioridad comercial primero                                                                                                                                                                                                                           |
| 13  | Recuperación de trabajos  | ✅ OK                  | Prueba G: con Queues caído, el trabajo queda `PENDING` en D1 y el Scheduler lo despacha y ejecuta. Recovery recupera leases vencidos y mensajes perdidos                                                                                                                                                                             |
| 14  | Idempotencia              | ✅ OK con brechas      | Webhooks, pagos, trabajos, publicaciones, conversiones y pedidos de canal: OK (prueba E). Brecha: `POST /v1/orders` manual sin clave de idempotencia (R-06)                                                                                                                                                                          |
| 15  | Cálculos financieros      | ✅ OK (2 correcciones) | Centavos enteros; redondeo conservador; Financial Guard; reservas de fondos; conciliación con tolerancia. Se corrigieron 2 casos de subestimación de costos (C-03, C-04)                                                                                                                                                             |
| 16  | Validación de proveedores | ✅ OK                  | VERIFIED exige 3 evidencias vigentes. Un proveedor suspendido después de aprobado bloquea la publicación (prueba A)                                                                                                                                                                                                                  |
| 17  | Verificación de stock     | ✅ OK (1 corrección)   | Stock UNKNOWN o vencido bloquea publicación y abastecimiento (prueba B). Se corrigió que la publicación aceptaba stock sin cantidad (C-05)                                                                                                                                                                                           |
| 18  | Máquina de estados        | ✅ OK                  | 15 estados. Transiciones por tabla y requisitos de evidencia también para decisiones manuales. 7 simulaciones verifican que cada paso sea legal                                                                                                                                                                                      |
| 19  | Adaptadores de canales    | ✅ OK con pendientes   | Basados en documentación oficial verificada. Lo no soportado responde UNSUPPORTED también en MOCK. Se corrigió el exceso de subrequests en el catálogo de Mercado Libre (C-06)                                                                                                                                                       |
| 20  | Dashboard                 | ✅ OK                  | 17 secciones cargan sin errores ni mensajes de consola; las acciones probadas funcionan; estados LOADING/EMPTY/ERROR/SUCCESS                                                                                                                                                                                                         |
| 21  | Responsive                | ✅ OK                  | Probado a 375×812 (menú lateral, KPIs en 2 columnas, formularios a ancho completo) y en escritorio                                                                                                                                                                                                                                   |
| 22  | Límites Cloudflare Free   | ❌ **ALTO**            | Pedido con pago: **70 consultas D1** en una solicitud (límite Free: 50). Ver R-01 y la tabla de la sección 4                                                                                                                                                                                                                         |

Dependencias:

- `npm audit --omit=dev`: **0 vulnerabilidades** en producción.
- `npm audit`: 4 moderadas, solo en herramientas de desarrollo (esbuild antiguo vía
  drizzle-kit). No llegan al Worker ni al dashboard.

---

## 2. Pruebas negativas obligatorias

Archivo: `tests/integration/audit-negative.test.ts` (21 tests, todos ✅).

| Caso  | Prueba                                                                   | Resultado                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | Proveedor suspendido después de aprobar el candidato → publicar          | ✅ 409, fallan `SUPPLIER_VERIFIED` y `RISK_GUARDIAN`. Bloquea aun en MOCK                                                                                                                                                               |
| **B** | Stock `UNKNOWN` → publicar; pedido pagado → abastecer                    | ✅ Publicación 409 (`STOCK_VERIFIABLE`). Pedido `BLOCKED_NO_STOCK`, sin pedido al proveedor                                                                                                                                             |
| B'    | Stock "disponible" sin cantidad → publicar                               | ✅ 409, tras la corrección C-05 (antes **se permitía**)                                                                                                                                                                                 |
| **C** | Precio bajado por debajo del margen mínimo → publicar                    | ✅ 409 (`MIN_MARGIN`)                                                                                                                                                                                                                   |
| **D** | Proveedor con adelanto y saldo insuficiente                              | ✅ `BLOCKED_CASHFLOW` (`PREPAYMENT_WITHOUT_FUNDS`); solicitud de despacho 409; forzar `FINANCIAL_APPROVED` manualmente da 409                                                                                                           |
| **E** | Mismo webhook 3 veces y procesado 2 veces; mismo pedido de canal 2 veces | ✅ 1 evento, 1 trabajo, 1 pedido de canal, 1 pedido interno (el segundo, 409)                                                                                                                                                           |
| **F** | Token revocado: el canal responde 401                                    | ✅ La integración pasa a `EXPIRED`; las operaciones siguientes dan 409 **sin llamar a la API**; la renovación fallida la mantiene `EXPIRED` (corrección C-02; antes **seguía `CONNECTED`**)                                             |
| **G** | Queues rechaza el encolado                                               | ✅ El trabajo queda `PENDING` en D1; el Scheduler lo despacha y se completa                                                                                                                                                             |
| **H** | Producción con un `X-Tenant-Id` válido en 7 operaciones administrativas  | ✅ 401 en todas. `/v1/tenants`: 403. **Sin `APP_ENV` → 401** (corrección C-01; antes **se asumía desarrollo**). En desarrollo, otro tenant: 404                                                                                         |
| **I** | Agente que intenta cambiar reglas                                        | ✅ No existe agente de reglas; el tipo `rules.update` da 400; un payload con `MIN_NET_MARGIN_BPS:0` y `COMMERCIAL_ACTIONS_ENABLED:true` no altera la configuración; por HTTP solo se registra una propuesta; `/health` sigue en `false` |
| **J** | Orden de compra real al proveedor y ejecución de reembolso               | ✅ 403 `COMMERCIAL_ACTIONS_DISABLED`; el pedido al proveedor sigue `SELECTED`; queda `DISPATCH_BLOCKED` en el registro; **0 requests salientes que no sean GET**                                                                        |

---

## 3. Correcciones aplicadas

| ID       | Severidad  | Falla                                                                                                                                                                                                                                                                                        | Corrección                                                                                                                                                                                                                                      |
| -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C-01** | 🔴 Crítica | `apps/api/wrangler.jsonc` tenía `APP_ENV: "development"` como variable global, y el esquema usaba `development` por defecto (fail-open). Un despliegue habría activado el header temporal `X-Tenant-Id` en Internet. Además, `GET /v1/tenants` lista los IDs: acceso total sin credenciales. | `APP_ENV` por defecto es `production` (fail-closed). `wrangler.jsonc` declara `production`. `npm run dev:api` pasa `--var APP_ENV:development`. Se verificó que el desarrollo local sigue funcionando y que, sin `APP_ENV`, la respuesta es 401 |
| **C-02** | 🟠 Alta    | Integración con token vencido o revocado: un 401 del canal no la suspendía y las operaciones (catálogo, pedidos, mensajes) seguían llamando a la API                                                                                                                                         | Un `UNAUTHORIZED` del canal pasa la conexión a `EXPIRED` ("suspendida hasta reconectar"). Una conexión LIVE que no esté `CONNECTED` rechaza operaciones; solo admite verificar, renovar, reconectar y desconectar                               |
| **C-03** | 🟠 Alta    | Validación financiera: si los costos de un ítem no se podían calcular, se usaba solo el costo del proveedor. Se subestimaban costos y podía aprobarse sin fondos suficientes                                                                                                                 | Fail-closed: se bloquea con `COST_DATA_INVALID`                                                                                                                                                                                                 |
| **C-04** | 🟡 Media   | En `MANUAL_REVIEW` con un pedido al proveedor ya solicitado, el costo unitario reconstruido era 0. Una aprobación manual se evaluaba con costos subestimados                                                                                                                                 | Costo unitario prorrateado del costo acordado (redondeo hacia arriba)                                                                                                                                                                           |
| **C-05** | 🟡 Media   | La publicación aceptaba stock "disponible" sin cantidad informada (stock desconocido)                                                                                                                                                                                                        | `STOCK_VERIFIABLE` exige cantidad informada y suficiente para las unidades ofrecidas                                                                                                                                                            |
| **C-06** | 🟡 Media   | `getCatalog` de Mercado Libre podía hacer 51 subrequests (Workers Free: 50)                                                                                                                                                                                                                  | Tope de 40 ítems (1 búsqueda + 40 consultas)                                                                                                                                                                                                    |

Además se actualizaron los tests afectados (`channel-rules.test.ts`) y se agregaron
`tests/integration/audit-negative.test.ts` y `tests/integration/command-api.test.ts`.

---

## 4. Límites de Cloudflare Free

Límites verificados en developers.cloudflare.com el 2026-11-17.

Consultas D1 medidas por solicitud HTTP (adaptador SQLite instrumentado):

| Operación                                                                  | Consultas D1 | Límite Free | Estado                  |
| -------------------------------------------------------------------------- | ------------ | ----------- | ----------------------- |
| `GET /v1/orders` (lista)                                                   | 3            | 50          | ✅                      |
| `GET /v1/orders/:id` (detalle)                                             | 14           | 50          | ✅                      |
| `GET /v1/command/overview`                                                 | 15           | 50          | ✅                      |
| `POST /v1/orders` (recepción + motor)                                      | 31           | 50          | ⚠️ Cerca del límite     |
| `POST /v1/orders/:id/payments` (pago + avance hasta aprobación financiera) | **70**       | 50          | ❌ **Supera el límite** |

Otros límites:

- **Workers Free, 10 ms de CPU por solicitud:** no se midió. Los flujos del motor de
  pedidos y del análisis de Discovery son candidatos a superarlo.
- **Queues Free, 10.000 operaciones/día (≈ 3 por mensaje):** alcanza para unos 3.300
  intentos de trabajo por día en toda la cuenta. El Scheduler despacha solo lo vencido.
- **Retención de Queues Free (24 h):** sin impacto, porque D1 es la fuente de verdad y el
  Recovery redespacha.
- **Cron Triggers:** 2 de 5. **Subrequests:** máximo 50 por invocación (C-06).
- **D1 (5M filas leídas y 100k escritas por día, 500 MB por base):** no se puede medir sin
  la API de analíticas. El Scheduler consulta D1 cada minuto (1.440 veces por día).

---

## 5. Vulnerabilidades y riesgos abiertos

| ID       | Severidad      | Descripción                                                                                                                                                                                | Recomendación                                                                                                                                                                      |
| -------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **V-01** | 🔴 **Crítica** | **Sin autenticación de usuarios.** Mitigado por C-01: fuera de desarrollo, todo `/v1` responde 401. Pero el sistema no es usable en producción sin login                                   | Fase 2: identidad real (p. ej. Cloudflare Access, gratuito hasta 50 usuarios, o sesiones propias con hash de contraseña)                                                           |
| **V-02** | 🟠 Alta        | En desarrollo, `GET /v1/tenants` lista todos los IDs y el header `X-Tenant-Id` da acceso completo. Aceptable solo en local                                                                 | No exponer nunca el modo desarrollo. Mantener `workers_dev: false`                                                                                                                 |
| **V-03** | 🟠 Alta        | **Sin roles.** Cualquier usuario del espacio registra fondos, resuelve revisiones, registra pagos manuales con evidencia y conecta canales. La tabla `users.role` existe pero no se aplica | Con la Fase 2: owner/admin para fondos, pagos manuales, reglas e integraciones                                                                                                     |
| **R-01** | 🟠 Alta        | **Límite D1 de 50 consultas por invocación** superado por el avance del motor (70)                                                                                                         | Agrupar lecturas con `db.batch()`, cachear los hechos dentro del avance, o diferir el avance a un trabajo de cola. Alternativa: plan Workers Paid (1.000 consultas por invocación) |
| R-02     | 🟡 Media       | CPU de 10 ms por solicitud en Free: sin medir                                                                                                                                              | Medir con `wrangler tail` en staging antes de habilitar                                                                                                                            |
| R-03     | 🟡 Media       | Notificaciones de Mercado Libre sin firma (así lo define Mercado Libre). Se mitiga con `application_id` + re-consulta, pero un tercero puede generar eventos y trabajos                    | Rate limiting por cuenta externa; descartar eventos de recursos inexistentes                                                                                                       |
| R-04     | 🟡 Media       | Sin rate limiting en rutas públicas (`/webhooks/*`, `/oauth/callback/*`, `/store/*`, `/r/:code`)                                                                                           | Regla de rate limiting de Cloudflare (el plan Free incluye una)                                                                                                                    |
| R-05     | 🟡 Media       | El número de pedido se calcula como `max + 1`: con concurrencia, el índice único hace fallar uno de los dos con 500                                                                        | Reintento ante conflicto o secuencia en una tabla                                                                                                                                  |
| R-06     | 🟡 Media       | `POST /v1/orders` manual sin clave de idempotencia: un doble envío crea dos pedidos                                                                                                        | Aceptar `Idempotency-Key`                                                                                                                                                          |
| R-07     | 🔵 Baja        | Ventanas de rate limiting de canales con lectura-escritura no atómica: con concurrencia, se puede exceder el cupo levemente                                                                | UPDATE condicional                                                                                                                                                                 |
| R-08     | 🔵 Baja        | Páginas de tienda sin Content-Security-Policy (el HTML ya se escapa)                                                                                                                       | Agregar CSP en `secureHeaders`                                                                                                                                                     |
| R-09     | 🔵 Baja        | Risk Guardian (promoción a candidato) acepta "disponible" sin cantidad. La publicación y el abastecimiento ya lo bloquean (C-05)                                                           | Alinear Risk Guardian con la regla de C-05                                                                                                                                         |
| R-10     | 🔵 Baja        | 4 vulnerabilidades moderadas en dependencias de desarrollo (drizzle-kit → esbuild)                                                                                                         | Actualizar cuando drizzle-kit publique la corrección                                                                                                                               |

## 6. Funcionalidades incompletas (conocidas y documentadas)

- **Autenticación y roles:** Fase 2.
- **Integraciones reales sin probar en LIVE:** no hay apps de Mercado Libre ni de Meta ni
  secrets cargados. Algunos detalles quedan sin verificar:
  - estados de órdenes de Mercado Libre distintos de `paid`;
  - el valor `object` de los webhooks de Instagram;
  - carruseles de Instagram.
- **Sin integración automática con:** proveedores, transportistas, pasarelas de pago ni
  redes de afiliados. Las confirmaciones se registran con comprobante.
- **Checkout de la tienda propia:** no configurado (503). No se simulan pagos.
- **Motor de pedidos:** un solo proveedor por pedido; sin registro de líneas de
  financiación.
- **Recursos gratuitos:** el uso de solicitudes y filas de D1 figura como "no medido".
- **Risk Guardian:** sin especificación formal en `docs/specs/`.
- **Base de datos remota:** `database_id` en `wrangler.jsonc` sigue siendo un marcador. No
  se desplegó nada.

## 7. Condiciones para declarar "listo para producción"

1. Resolver V-01 y V-03 (autenticación y roles).
2. Resolver R-01 y medir R-02 en staging. Si no entra en el plan Free, decidirlo
   explícitamente (implicaría costo, hoy fuera del presupuesto USD 0).
3. Mitigar R-03, R-04, R-05 y R-06.
4. Probar cada integración en LIVE contra cuentas de prueba oficiales, con
   `COMMERCIAL_ACTIONS_ENABLED=false`.
5. Recién después, evaluar habilitar acciones comerciales de forma gradual.

## 8. Cómo reproducir

```bash
npm run check
npx vitest run tests/integration/audit-negative.test.ts --silent=false
npm run db:check -w @vc/database
npm audit --omit=dev
```

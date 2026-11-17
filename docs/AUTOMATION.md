# Automation Core

Sistema de automatización permanente sobre Cloudflare Workers + D1 + Queues +
Cron Triggers. **D1 es la fuente de verdad**; la cola solo transporta punteros
(`job.execute { jobId }`). Si un mensaje se pierde (por ejemplo, por la retención
limitada de Queues en el plan gratuito), el Recovery Worker lo re-despacha desde D1.

> Ningún trabajo compra, publica, cobra ni contacta terceros. Toda la auditoría
> del motor se registra con `dry_run = true`.

## Componentes

| Componente     | Archivo (`apps/api/src/automation/`)   | Responsabilidad                                                      |
| -------------- | -------------------------------------- | -------------------------------------------------------------------- |
| Orchestrator   | `orchestrator.ts`                      | Entrada única: rutea cron → Scheduler/Recovery y cola → consumidor   |
| Scheduler      | `scheduler.ts`                         | Materializa programaciones, cancela vencidos, despacha por prioridad |
| Queue Producer | `producer.ts`                          | Envía punteros ordenados por prioridad; registra `dispatched_at`     |
| Queue Consumer | `orchestrator.ts` (`handleQueueBatch`) | Ordena el lote por prioridad, ejecuta, ack/retry, DLQ                |
| Job Manager    | `job-manager.ts`                       | Alta idempotente, cancelación, reintento manual, consultas           |
| Retry Manager  | `executor.ts`                          | Clasifica errores, backoff, límite de intentos, DEAD_LETTER          |
| Audit Logger   | `audit-logger.ts`                      | `audit_events` append-only, metadatos redactados                     |

Lógica pura (sin I/O, testeable) en `packages/queue/src/automation/`:
errores y timeouts, backoff, cálculo de horarios por zona, circuit breaker y
estados de trabajos.

## Cron Triggers: exactamente 2 (UTC)

| Cron          | Nombre          | Hace                                                                                    |
| ------------- | --------------- | --------------------------------------------------------------------------------------- |
| `* * * * *`   | Scheduler       | Programaciones vencidas → trabajos; vencidos → CANCELLED; listos → cola                 |
| `*/5 * * * *` | Recovery Worker | Leases vencidos → RETRYING/DEAD_LETTER; mensajes perdidos → re-envío; limpieza de locks |

No se crea un Cron Trigger por agente. Las frecuencias de cada agente viven en
D1 (`job_schedules`) y se editan desde el dashboard (pestaña **Automatización**).

## Hora Argentina

Cloudflare Cron corre en UTC. Cada programación guarda su zona IANA (por defecto
`America/Argentina/Buenos_Aires`, hoy UTC−3) y la hora local (`HH:MM`). El
servidor convierte a UTC con la base de zonas del runtime (`Intl`), así que:

- no se asume que el reloj ni la zona del navegador sean la hora oficial;
- el dashboard muestra la hora del **servidor** (`GET /v1/automation/clock`) y
  formatea con la zona explícita;
- si Argentina volviera a usar horario de verano, el cálculo se ajusta solo.

Frecuencias: `INTERVAL` (cada N minutos), `DAILY` (hora local), `WEEKLY` (días y hora local).

## Estados

```
PENDING ─┐                      ┌─▶ COMPLETED
         ├─▶ RUNNING ───────────┼─▶ FAILED ──────┐ (reintento manual)
SCHEDULED┘      │               ├─▶ RETRYING ─┐  │
   ▲            │               └─▶ DEAD_LETTER ◀┘
   │            └── (lease vencido) ──▶ RETRYING / DEAD_LETTER
   └── runAt futuro          PENDING/SCHEDULED/RETRYING ─▶ CANCELLED (manual o vencido)
```

| Estado      | Significado                                            |
| ----------- | ------------------------------------------------------ |
| PENDING     | Listo para ejecutar                                    |
| SCHEDULED   | `run_at` en el futuro                                  |
| RUNNING     | Tomado por un ejecutor con lock (lease)                |
| COMPLETED   | Terminó bien; `result` guardado                        |
| FAILED      | Error permanente (no se reintenta solo)                |
| RETRYING    | Error recuperable; espera backoff                      |
| CANCELLED   | Cancelado a mano o vencido (`last_error = EXPIRED`)    |
| DEAD_LETTER | Agotó intentos, o su mensaje cayó en la DLQ de la cola |

## Garantías

| Mecanismo         | Implementación                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Idempotencia      | Índice único `(tenant_id, idempotency_key)`; misma clave ⇒ mismo trabajo. Programaciones usan `schedule:<id>:<instante>` |
| Lock de trabajo   | `UPDATE … WHERE status IN (…) AND attempts = ? RETURNING` (compare-and-set) + lease `locked_until`                       |
| Lock global       | Tabla `locks` con vencimiento: Scheduler y Recovery nunca corren en paralelo                                             |
| Timeout           | `withTimeout` por trabajo (`timeout_seconds`); lease = timeout + 30 s                                                    |
| Resultado tardío  | Las escrituras finales exigen el lock propio; si se perdió, se descarta y se audita                                      |
| Reintentos        | Backoff exponencial 30 s × 2ⁿ (tope 1 h, jitter determinístico); `max_attempts` por trabajo                              |
| Errores           | `PermanentJobError` ⇒ FAILED; `RecoverableJobError`, timeout o desconocido ⇒ RETRYING                                    |
| Circuit breaker   | Por tenant y tipo: 5 fallas recuperables seguidas ⇒ OPEN 5 min ⇒ HALF_OPEN (1 prueba)                                    |
| Dead letter       | Intentos agotados ⇒ DEAD_LETTER; DLQ de Queues ⇒ marca DEAD_LETTER en D1                                                 |
| Recuperación      | Recovery Worker: leases vencidos, mensajes perdidos (>15 min), programaciones sin próxima ejecución                      |
| Atrasos (misfire) | Una programación muy atrasada corre **una vez** y se recalcula desde ahora (sin ráfagas)                                 |
| Prioridad         | Menor número = antes. COMMERCIAL = 10, NORMAL = 50, LOW = 80. Se aplica al despachar y dentro de cada lote               |

## Agentes registrados (`handlers.ts`)

| Tipo                            | Categoría   | Hace                                                          |
| ------------------------------- | ----------- | ------------------------------------------------------------- |
| `profit.recalculate_product`    | COMMERCIAL  | Recalcula y guarda la rentabilidad de producto + oferta       |
| `inventory.stale_scan`          | MAINTENANCE | Reporta ofertas con stock desconocido, viejo o agotado        |
| `supplier.evidence_expiry_scan` | MAINTENANCE | Reporta verificados con evidencia vencida (no cambia estados) |
| `system.ping`                   | SYSTEM      | Prueba la cadena Scheduler → Cola → Consumidor                |

Agregar un agente = un `defineHandler()` nuevo + una programación en D1. Nada más.

## API (`/v1/automation`, header `X-Tenant-Id`, solo desarrollo)

| Método   | Ruta                                     | Descripción                                              |
| -------- | ---------------------------------------- | -------------------------------------------------------- |
| GET      | `/clock`                                 | Hora del servidor (UTC y Argentina) y crons              |
| GET      | `/job-types`                             | Agentes registrados                                      |
| GET/POST | `/jobs`                                  | Listar (`?status=`) / encolar (201 nuevo, 200 duplicado) |
| GET      | `/jobs/:id`                              | Detalle con intentos                                     |
| POST     | `/jobs/:id/cancel` · `/retry`            | Cancelar / reintento manual                              |
| GET/POST | `/schedules` · PATCH `/:id`              | Programaciones (frecuencia, zona, pausa)                 |
| GET      | `/circuit-breakers` · POST `/:key/reset` | Estado y reinicio                                        |
| POST     | `/tick/scheduler` · `/tick/recovery`     | Ejecución manual (desarrollo)                            |

## Desarrollo local

`wrangler dev` procesa la cola localmente, pero no dispara Cron Triggers solo.
Usar los botones **Ejecutar Scheduler / Ejecutar Recovery** del dashboard (o
`POST /v1/automation/tick/:which`).

## Cuotas del plan gratuito

Verificar los valores vigentes en la documentación oficial de Cloudflare. Con el
diseño actual, el Scheduler hace ~1 440 invocaciones/día y unas pocas escrituras
D1 por tick (lock + despachos); cada trabajo cuesta ~3 operaciones de cola
(envío, lectura, ack). Si se acercan los límites, aumentar el intervalo de
programaciones antes que agregar crons.

# Order + Fulfillment Engine

Sistema completo de pedidos: recepción, pago, stock, proveedor, finanzas, despacho,
entrega, cancelación, devolución, conciliación y atención al cliente.

Principio rector: **un pedido avanza solo con evidencia**. El motor es puro y
determinístico (`packages/business-rules/src/orders`). La API junta los hechos registrados
y aplica cada paso con compare-and-set (`apps/api/src/modules/orders`). No se ejecutan
transacciones reales.

## Estados

| Flujo principal                                       | Bloqueos           |
| ----------------------------------------------------- | ------------------ |
| `NEW` → `PAYMENT_PENDING` → `PAYMENT_CONFIRMED`       | `BLOCKED_NO_STOCK` |
| → `SUPPLIER_STOCK_VERIFIED` → `FINANCIAL_APPROVED`    | `BLOCKED_CASHFLOW` |
| → `SUPPLIER_ORDER_ACCEPTED` → `SHIPPED` → `DELIVERED` | `BLOCKED_SUPPLIER` |
| → `SETTLED`                                           | `MANUAL_REVIEW`    |
|                                                       | `REFUND_REQUIRED`  |

**`CANCELLED`** es un estado terminal agregado para la gestión de cancelaciones. Incluye
los pedidos anulados con reembolso acreditado (`refunded: true`).

La tabla de transiciones está en `ORDER_TRANSITIONS`. Además de figurar en esa tabla,
**cada estado destino exige su evidencia** (`requirementsFor`), también cuando decide un
administrador.

| Para entrar a…            | Se exige                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `PAYMENT_CONFIRMED`       | Cobros APROBADOS con comprobante del canal de pago que cubren el total, en la misma moneda |
| `SUPPLIER_STOCK_VERIFIED` | Proveedor verificado y operable con stock confirmado reciente y cantidad suficiente        |
| `FINANCIAL_APPROVED`      | Financial Guard APPROVED con el saldo registrado menos lo comprometido                     |
| `SUPPLIER_ORDER_ACCEPTED` | Aceptación del proveedor con comprobante                                                   |
| `SHIPPED`                 | Transportista, número de seguimiento y comprobante del despacho                            |
| `DELIVERED`               | Evidencia de entrega                                                                       |
| `SETTLED`                 | Conciliación `MATCHED` y ninguna devolución abierta                                        |
| `CANCELLED`               | Nada cobrado sin reintegrar, sin envío en curso y sin proveedor que haya aceptado          |

## Reglas no negociables (cómo se cumplen)

- **Pago confirmado solo con evidencia.**
  - Cada pago registra medio, ID de operación, fuente de la evidencia (webhook o API del
    canal, reporte del medio de pago o comprobante manual) y la referencia del comprobante.
  - No se aceptan fechas futuras.
  - Es idempotente por evento del canal de pago.
  - Un pedido de un canal LIVE en estado `PAID` registra como evidencia la orden informada
    por la API. Los pedidos de conexiones MOCK no se procesan como reales.
- **Nunca se ordena sin dinero disponible.** Se reutiliza el **Financial Guard**:
  - Usa el último saldo registrado con comprobante (`funds_snapshots`, vigencia máxima
    `MAX_FUNDS_DATA_AGE_HOURS`).
  - A ese saldo se le restan las reservas de otros pedidos aprobados y los pagos a
    proveedores registrados después del saldo.
  - Si no hay saldo registrado, el pedido queda `BLOCKED_CASHFLOW`.
  - Si el canal no informa la fecha de liquidación, se asume el peor caso: el canal liquida
    después del vencimiento al proveedor.
- **Nunca se informa un despacho sin confirmación verificable.**
  - `SHIPPED` exige el comprobante.
  - El agente no marca "demorado" por su cuenta, porque eso lo informa el transportista.
  - Si no hay entrega confirmada **72 h** después de la fecha estimada, el pedido pasa a
    `MANUAL_REVIEW`.
- **Nunca información falsa al comprador:**
  - `buyerStatusText` y las plantillas solo afirman hechos verificados.
  - La plantilla "despachado" no está disponible sin comprobante.
  - Los bloqueos se comunican como "en revisión", sin detalles internos.

## Funciones

| Función                     | Dónde / cómo                                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recepción                   | `POST /v1/orders`: valida productos y moneda; opcionalmente se vincula al pedido del canal                                                                                                          |
| Validación de pago          | `POST /:id/payments` (cobros y reembolsos)                                                                                                                                                          |
| Verificación de stock       | Automática: última lectura de stock por oferta, que no debe estar vencida, con cantidad ≥ pedida                                                                                                    |
| Selección de proveedor      | `selectSupplier`: un proveedor para todos los ítems, verificado, con precio vigente y la misma moneda. Gana el menor costo; desempata el puntaje y después el plazo. Excluye a los que fallaron     |
| Validación de financiación  | `evaluateOrderFinance` (Financial Guard). La reserva de fondos se libera al registrar el pago al proveedor o al cancelar                                                                            |
| Solicitud de despacho       | `POST /:id/dispatch-request`: es una orden de compra (`place_supplier_order`); con el interruptor apagado queda **bloqueada y registrada**                                                          |
| Confirmación del proveedor  | `POST /:id/supplier-response` (aceptación con comprobante o rechazo con motivo)                                                                                                                     |
| Proveedor sin respuesta     | Agente `orders.supplier_timeout_scan`: lo marca `NO_RESPONSE`, `BLOCKED_SUPPLIER`, lo excluye y elige otro                                                                                          |
| Transportista y seguimiento | `POST /:id/shipments`                                                                                                                                                                               |
| Actualización de estados    | `POST /:id/shipment-events` (entregado o demorado), `POST /:id/advance` y el agente `orders.reevaluate`                                                                                             |
| Cancelaciones               | `POST /:id/cancel`: sin cobro pasa a `CANCELLED`; con cobro, a `REFUND_REQUIRED`; si el proveedor ya aceptó, a `MANUAL_REVIEW`                                                                      |
| Devoluciones                | `/returns`, `/returns/decision` y `/returns/received`; al recibirse pasa a `REFUND_REQUIRED` y el envío queda `RETURNED`                                                                            |
| Reembolsos                  | El sistema **no** los ejecuta (`/refund-execution` queda bloqueado y registrado). Se hacen en el medio de pago y se registran con evidencia                                                         |
| Conciliación económica      | `POST /:id/ledger`, en `order_ledger_entries`, cada movimiento con comprobante. Se compara con el neto del Profit Engine (tolerancia 1 % o 100 centavos). Si hay diferencia, pasa a `MANUAL_REVIEW` |
| Revisión manual             | `POST /:id/resolve`: se ofrecen solo los destinos cuyos requisitos ya se cumplen                                                                                                                    |
| Registro completo           | `order_events` (append-only): cada cambio, actor, motivo, selección, evaluación financiera y evidencia                                                                                              |

Las ventas y los reembolsos entran al registro económico **solo** a partir de pagos
aprobados con evidencia. Los demás movimientos exigen comprobante y la misma moneda. No se
convierten monedas.

## Atención al cliente (`/v1/support`)

- **Consultas** (tickets), con o sin pedido asociado.
- **Preguntas frecuentes:** las carga el negocio. Se sugieren por palabras clave, sin
  acentos y sin IA.
- **Estado de pedido por número:** `GET /order-status/:number`, solo con hechos
  verificados.
- **Respuestas con plantillas:** cada plantilla verifica sus hechos. Por ejemplo,
  `SHIPPED` exige comprobante y seguimiento, `SHIPPING_DELAYED` exige que el transportista
  haya informado la demora, y `RETURN_INSTRUCTIONS` exige el plazo del proveedor vigente.
- **Escalamiento a administrador:**
  - Automático ante términos sensibles (reclamo, denuncia, estafa, defensa del consumidor…)
    o cuando el pedido está en `MANUAL_REVIEW` o `REFUND_REQUIRED`.
  - También manual.
  - Queda en el registro del pedido.
- **Envío:** contactar al cliente es una acción comercial, así que con el interruptor
  apagado la respuesta queda `BLOCKED`. Aun habilitado, la respuesta queda preparada para
  enviarse desde el canal; el módulo de mensajes aplica la ventana de 24 h de WhatsApp.

## Simulaciones (`POST /v1/orders/simulations/:escenario`)

Corren en memoria con **las mismas reglas puras**: máquina de estados, selección,
Financial Guard, conciliación y plantillas. Usan datos sintéticos marcados "(sim)", no
crean pedidos y no tocan la base. Cada escenario devuelve el paso a paso, los mensajes al
comprador y las acciones que en la realidad requerirían habilitación.

| Escenario              | Resultado                                                                   |
| ---------------------- | --------------------------------------------------------------------------- |
| `HAPPY_PATH`           | `SETTLED`. El aviso de despacho previo al despacho real se rechaza          |
| `PAYMENT_REJECTED`     | `CANCELLED`, sin tocar al proveedor                                         |
| `NO_STOCK`             | `BLOCKED_NO_STOCK` → reintegro con evidencia → `CANCELLED`                  |
| `SUPPLIER_NO_RESPONSE` | `BLOCKED_SUPPLIER` → se excluye y se elige otro → `SUPPLIER_ORDER_ACCEPTED` |
| `CASHFLOW_PROBLEM`     | `BLOCKED_CASHFLOW` → con saldo actualizado → `FINANCIAL_APPROVED`           |
| `SHIPPING_DELAYED`     | Se avisa la demora informada; 72 h sin entrega → `MANUAL_REVIEW`            |
| `RETURN`               | Devolución recibida → `REFUND_REQUIRED` → reintegro → `CANCELLED`           |

## Limitaciones conocidas / a especificar

- **Un proveedor por pedido.** Si ningún proveedor cubre todos los ítems, el pedido queda
  bloqueado. No se divide en varios envíos.
- **Riesgo de devolución:** se toma de la reserva de devoluciones (`RETURN_RESERVE`)
  configurada en los costos del producto. Si no existe, se usa 0 (los costos ya incluyen la
  reserva).
- **Sin integración automática con proveedores, transportistas ni pasarelas de pago.** Las
  confirmaciones se registran con su comprobante.
- **Líneas de financiación:** no hay un registro todavía, así que el Financial Guard se
  evalúa sin financiación.

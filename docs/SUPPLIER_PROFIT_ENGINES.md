# Supplier Engine, Profit Engine y Financial Guard

Reglas de negocio de los módulos centrales. Todas son **funciones puras** en
`packages/business-rules` (sin I/O, con `now` inyectado) y funcionan sin
integraciones externas. La API (`apps/api/src/modules/*`) solo lee datos,
llama a estas reglas y persiste el resultado.

> No hay compras ni publicaciones reales. Toda acción comercial sigue bloqueada
> por `COMMERCIAL_ACTIONS_ENABLED=false`.

## Supplier Engine

Proveedores que despachan directo al comprador (sin inventario propio).

**Datos:** datos comerciales (razón social, nombre de fantasía, CUIT, web), país y
ubicación, contactos, medios de pago, despacho directo, plazos de preparación y
entrega, política de devoluciones, seguimiento, condiciones de pago al proveedor
(prepago, días de vencimiento), estado, puntaje e historial.

**Catálogo:** `supplier_products` (SKU, precio mayorista, moneda, fecha y origen
del precio). **Stock:** `supplier_inventory`, histórico de controles; el vigente es
el más reciente.

### Estados

```
UNVERIFIED ──▶ UNDER_REVIEW ──▶ VERIFIED ──▶ SUSPENDED
    │              │   ▲            │            │
    └──▶ REJECTED ◀┘   └────────────┘◀───────────┘
              └──────▶ UNDER_REVIEW
```

| Desde        | Hacia permitido                |
| ------------ | ------------------------------ |
| UNVERIFIED   | UNDER_REVIEW, REJECTED         |
| UNDER_REVIEW | VERIFIED, REJECTED, UNVERIFIED |
| VERIFIED     | SUSPENDED, UNDER_REVIEW        |
| SUSPENDED    | UNDER_REVIEW, REJECTED         |
| REJECTED     | UNDER_REVIEW                   |

Tabla única en `@vc/shared` (`SUPPLIER_TRANSITIONS`), usada por API y dashboard.

### Regla de verificación

Un proveedor **no puede pasar a VERIFIED** sin evidencia **aceptada y vigente** de:

1. `IDENTITY` — identidad
2. `COMMERCIAL_TERMS` — condiciones comerciales
3. `DISPATCH_CAPABILITY` — capacidad de despacho

y además debe tener `directDispatch = true`.

- La evidencia se registra con `POST /v1/suppliers/:id/evidence` y entra como `PENDING`.
- Se revisa una sola vez (`ACCEPTED` / `REJECTED`); para corregir se registra otra.
- Evidencia vencida (`expiresAt`) deja de contar: un VERIFIED con evidencia vencida
  queda **no operable** (`SUPPLIER_EVIDENCE_EXPIRED`).
- Editar condiciones materiales de un VERIFIED (razón social, CUIT, país, despacho
  directo, prepago, plazo de pago, devoluciones) lo devuelve a `UNDER_REVIEW`.
- Cada cambio de estado queda en `supplier_status_history` y en `audit_events`.

### Puntuación (0–100)

| Bloque    | Pts | Criterio                                                                                    |
| --------- | --- | ------------------------------------------------------------------------------------------- |
| Evidencia | 40  | Identidad 15 · Condiciones 15 · Despacho 10 (aceptada y vigente)                            |
| Operación | 35  | Despacho directo 10 · Seguimiento 8 · Entrega ≤3d 10/≤7d 7/≤15d 4 · Preparación ≤1d 7/≤3d 4 |
| Comercial | 25  | Acepta devoluciones 8 · Ventana ≥30d 4/≥10d 2 · Sin prepago 8 · Plazo de pago ≥15d 5/<15d 2 |
| Penalidad | −15 | −5 por evidencia rechazada                                                                  |

Datos desconocidos puntúan 0: nunca se asume lo favorable.

## Profit Engine

`calculateProfit()` — función pura:

```
beneficio neto = precio de venta − costo proveedor − Σ componentes
margen neto    = beneficio neto / precio de venta
```

Componentes configurables por producto (`product_costs`): envío, comisión del
canal, costo de cobro, impuestos, retenciones, reserva de devoluciones, otros.
Cada uno es un monto fijo, un % sobre el precio de venta, o ambos.

- Montos en centavos enteros; porcentajes en basis points; redondeo hacia más costo.
- **Impuestos**: se configuran como tasa efectiva sobre el precio final. Si el precio
  incluye IVA, la tasa efectiva es `alícuota / (1 + alícuota)` (p. ej. 21 % → 17,36 %).
  El sistema no codifica alícuotas: las define quien opera, según su situación fiscal.
- **Retenciones**: se tratan como costo (criterio conservador de caja).
- **Umbral**: margen neto mínimo `MIN_NET_MARGIN_BPS` (default 2000 = 20 %).

Resultado: `PROFITABLE`, `BELOW_MIN_MARGIN` o `NEGATIVE_MARGIN`.

### Viabilidad de un producto

`evaluateViability()` combina proveedor, evidencia, oferta, stock y costos.
Junta **todos** los problemas; cualquiera no económico ⇒ `BLOCKED`:

| Motivo                                 | Cuándo                                                  |
| -------------------------------------- | ------------------------------------------------------- |
| `SUPPLIER_NOT_VERIFIED`                | El proveedor no está VERIFIED                           |
| `SUPPLIER_EVIDENCE_EXPIRED`            | VERIFIED pero con evidencia obligatoria vencida         |
| `SUPPLIER_NO_DIRECT_DISPATCH`          | VERIFIED sin despacho directo                           |
| `STOCK_UNKNOWN`                        | Sin control de stock o con estado UNKNOWN               |
| `STOCK_STALE`                          | Último control más viejo que `MAX_STOCK_AGE_HOURS` (24) |
| `OUT_OF_STOCK`                         | Sin stock                                               |
| `PRICE_STALE`                          | Precio más viejo que `MAX_PRICE_AGE_HOURS` (72)         |
| `CURRENCY_MISMATCH`                    | Monedas distintas (no se inventan tipos de cambio)      |
| `NEGATIVE_MARGIN` / `BELOW_MIN_MARGIN` | Resultado económico                                     |

Cada cálculo se guarda en `profit_calculations` con una foto de los datos usados.

## Financial Guard

`evaluateFinancialGuard()` — función pura. Antes de aprobar una operación verifica:

| Control                                                                                                             | Bloqueo                                     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Dato de fondos con más de `MAX_FUNDS_DATA_AGE_HOURS` (24) o en el futuro                                            | `FUNDS_DATA_STALE` / `FUNDS_DATA_IN_FUTURE` |
| Proveedor cobra **antes** de que el canal liquide, sin fondos ni financiación para costos + reserva de devoluciones | `PREPAYMENT_WITHOUT_FUNDS`                  |
| Financiación con plazo menor a la brecha                                                                            | `FINANCING_TERM_INSUFFICIENT`               |
| Fondos + financiación menores a lo requerido                                                                        | `INSUFFICIENT_FUNDS`                        |
| Costos mayores a la liquidación esperada                                                                            | `COSTS_EXCEED_SETTLEMENT`                   |
| Riesgo de devolución > `MAX_RETURN_RISK_BPS` (15 %)                                                                 | `HIGH_RETURN_RISK`                          |
| Costo de financiación vuelve negativa la operación                                                                  | `UNPROFITABLE_AFTER_FINANCING`              |

**Sin datos ficticios:** el contrato exige todos los campos, con origen
(`MANUAL`, `SUPPLIER_REPORT`, `INTEGRATION`) y fecha del dato de fondos. No hay
valores por defecto ni saldos simulados; lo que falta se rechaza (400).

## Endpoints

Todos bajo `/v1`, con header `X-Tenant-Id` (temporal, solo `APP_ENV=development`).

| Método    | Ruta                                         | Descripción                                      |
| --------- | -------------------------------------------- | ------------------------------------------------ |
| GET/POST  | `/tenants`                                   | Espacios de trabajo (solo dev)                   |
| GET/POST  | `/suppliers`                                 | Listar / registrar                               |
| GET/PATCH | `/suppliers/:id`                             | Detalle (evidencia, historial, puntaje) / editar |
| POST      | `/suppliers/:id/evidence`                    | Registrar evidencia                              |
| POST      | `/suppliers/:id/evidence/:evidenceId/review` | Aceptar / rechazar                               |
| POST      | `/suppliers/:id/status`                      | Cambiar estado                                   |
| GET/POST  | `/supplier-products`                         | Catálogo de proveedores (`?productId=`)          |
| PATCH     | `/supplier-products/:id/price` · `/link`     | Precio mayorista / vínculo                       |
| GET/POST  | `/supplier-products/:id/inventory`           | Historial / registrar control                    |
| GET/POST  | `/products` · GET/PATCH `/products/:id`      | Productos propios                                |
| GET/POST  | `/products/:id/costs` · DELETE `/:costId`    | Componentes de costo                             |
| POST      | `/products/:id/profit-calculations`          | Calcular y registrar                             |
| GET       | `/profit-calculations`                       | Historial                                        |
| POST      | `/profit/simulate`                           | Simulación pura (no persiste)                    |
| POST      | `/financial-guard/evaluate`                  | Evaluar operación (auditada)                     |

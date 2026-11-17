# Discovery Engine, Product Scoring, Risk Guardian y Content Engine

Motor de investigación comercial. Principio rector: **solo datos observados**.
Cada dato registra fuente (`source_id` + `source_ref`) y fecha (`observed_at`),
más la fecha de carga (`recorded_at`). No se inventa demanda, precios ni
estadísticas: si falta un dato, el análisis lo muestra como faltante.

## Fuentes y adaptadores intercambiables

`packages/integrations/src/discovery.ts` define `DiscoveryAdapter`. Cada tipo de
fuente se resuelve con un adaptador; si no hay conector, queda **NOT_CONFIGURED**.

| Tipo               | Estado actual  | Comportamiento                                                        |
| ------------------ | -------------- | --------------------------------------------------------------------- |
| `GOOGLE_TRENDS`    | NOT_CONFIGURED | Sin conector. Requiere acceso oficial autorizado; no se hace scraping |
| `PUBLIC_SOURCE`    | NOT_CONFIGURED | Cada fuente necesita revisar sus términos antes de integrarse         |
| `COMMERCIAL_API`   | NOT_CONFIGURED | Requiere credenciales y contrato de una API autorizada                |
| `SUPPLIER_CATALOG` | CONFIGURED     | Detecta productos desde las ofertas de proveedores en D1              |
| `MANUAL`           | CONFIGURED     | Una persona carga los datos con fuente, referencia y fecha            |

Conectar una fuente real = implementar `DiscoveryAdapter` y pasarlo a
`createDiscoveryAdapters({ KIND: adapter })` en `apps/api/src/modules/discovery/service.ts`.
Un dato observado a mano en Google Trends puede registrarse citando esa fuente y la URL.

## Datos registrados

| Tabla                 | Contenido                                                                   |
| --------------------- | --------------------------------------------------------------------------- |
| `research_sources`    | Fuentes, tipo, autorización de uso, última sincronización                   |
| `product_categories`  | Categorías y palabras clave para clasificación por regla                    |
| `competitors`         | Competidores por canal                                                      |
| `discovered_products` | Productos detectados: estado, categoría, vínculos comerciales               |
| `demand_observations` | Métrica, valor y unidad tal como los informa la fuente                      |
| `price_observations`  | Precios observados (opcionalmente por competidor)                           |
| `product_attributes`  | Características con verificación: VERIFIED / SUPPLIER_DECLARED / UNVERIFIED |
| `product_images`      | Imágenes con autorización: NONE / OWN_PHOTO / SUPPLIER_WRITTEN / LICENSED   |
| `discovery_analyses`  | Historial de puntaje, señales de mercado y Risk Guardian                    |
| `generated_contents`  | Contenido versionado + foto de los hechos usados + compliance               |

Estados de un producto detectado: `RESEARCHING` → `CANDIDATE` (solo vía Risk
Guardian) o `DISCARDED` (con motivo; se puede reabrir).

## Análisis de mercado (`packages/business-rules/src/discovery/market.ts`)

- **Tendencia**: regresión lineal sobre la métrica con más observaciones. Con menos
  de 3 puntos → `INSUFFICIENT_DATA`. Cambio > ±10 % cada 30 días → RISING / FALLING.
  En `SALES_RANK`, bajar el número es subir la demanda.
- **Precios**: mediana de los últimos 30 días, variación contra los 30 previos y
  cantidad de competidores distintos.
- **Saturado** si: ≥ 10 competidores activos; o ≥ 5 competidores y la mediana cayó ≥ 10 %;
  o ≥ 5 competidores y demanda en baja.
- **Oportunidad** si: puntaje ≥ 65, confianza ≥ 60 %, no saturado y demanda no en baja.
  Una oportunidad **no aprueba nada**.

## Product Scoring (0–100)

| Componente                  | Peso | Fuente del dato                                       |
| --------------------------- | ---- | ----------------------------------------------------- |
| Rentabilidad                | 25   | Margen neto de la viabilidad fresca (100 = 2× mínimo) |
| Confiabilidad del proveedor | 20   | Puntaje del Supplier Engine                           |
| Disponibilidad              | 15   | Último control de stock (vencido = mitad)             |
| Competencia                 | 15   | Competidores observados en 30 días                    |
| Demanda observada           | 15   | Tendencia (RISING 90 / STABLE 60 / FALLING 25)        |
| Facilidad logística         | 10   | Plazo de entrega y seguimiento del proveedor          |

Un componente sin datos vale `null` y aporta 0. La **confianza** es el porcentaje
del peso con datos reales.

## Risk Guardian

Controles **obligatorios** para pasar a CANDIDATO (`risk-guardian.ts`):

- oferta de proveedor y producto propio vinculados;
- proveedor VERIFIED con evidencia vigente y despacho directo;
- stock confirmado, reciente y disponible;
- precio del proveedor vigente;
- misma moneda;
- margen neto ≥ mínimo.

Reutiliza la evaluación de viabilidad del Profit Engine (sin persistir).
**La función no recibe la puntuación**: ningún puntaje puede saltear un control.
La promoción siempre re-analiza y responde 409 con los bloqueos si no pasa.

## Content Engine

Plantillas propias y determinísticas (`content-engine.ts`, versión `v1`). Genera:
nombre comercial, título SEO (≤ 60), descripción, características, beneficios,
preguntas frecuentes, Instagram, WhatsApp, descripción para tienda y para
marketplaces (texto plano, sin enlaces ni contacto).

Reglas:

- Solo para productos **candidatos** (ya pasaron Risk Guardian).
- Características: solo atributos VERIFIED o SUPPLIER_DECLARED (estos últimos
  aclaran "según el proveedor"). Los UNVERIFIED se excluyen y se informan.
- Beneficios y preguntas: solo con datos reales del proveedor (plazo de entrega,
  seguimiento, devoluciones). Si un dato falta, la sección se omite.
- Imágenes: solo las que tienen autorización registrada con evidencia.
- Compliance: términos prohibidos siempre ("el mejor", "milagro", "cura"…) y
  términos que requieren respaldo en los hechos ("gratis", "garantía", "original",
  "oferta"…). Las plantillas no los agregan; si aparecen, vienen del título o de
  un atributo y el contenido queda marcado para revisión.

## Automatización

Agentes registrados en el Automation Core (frecuencia configurable desde el dashboard):

- `discovery.rescore`: re-analiza productos activos.
- `discovery.source_sync` (`{ sourceId }`): sincroniza una fuente; si no está
  conectada termina informando NOT_CONFIGURED.

## API (`/v1/discovery`)

`GET/POST /sources` · `PATCH /sources/:id` · `POST /sources/:id/sync` ·
`GET/POST /categories` · `GET/POST /competitors` · `GET /radar` ·
`GET/POST /products` (`?status=`) · `GET/PATCH /products/:id` ·
`POST /products/:id/{classify,demand,prices,attributes,images,analyze,promote,discard,reopen,content}` ·
`GET /content`.

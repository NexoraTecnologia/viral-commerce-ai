# Integraciones omnicanal

Arquitectura de canales comerciales: **Mercado Libre Argentina, Instagram, WhatsApp
Business Cloud API, tienda propia y programas de afiliados**.

Reglas de este módulo:

- Cada adaptador implementa solo lo que la **API oficial** permite.
- Lo que la API no ofrece responde `UNSUPPORTED_OPERATION`. Nunca se simula, ni siquiera
  en MOCK.
- Una conexión LIVE recién queda `CONNECTED` después de verificarla contra la API. No se
  fingen conexiones.
- No se publica, envía ni cobra nada real mientras `COMMERCIAL_ACTIONS_ENABLED=false`.

## Fuentes verificadas

Documentación oficial consultada el 2026-11-17.

| Canal         | Páginas                                                                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mercado Libre | developers.mercadolibre.com.ar/es_ar: `autenticacion-y-autorizacion`, `productos-recibe-notificaciones`, `publica-productos`, `items-y-busquedas`, `gestiona-preguntas-respuestas`, `gestiona-ventas` |
| Instagram     | developers.facebook.com/documentation/instagram-platform: `content-publishing`, `overview`, `instagram-api-with-instagram-login/business-login` y `get-started`, `ig-user/media`, `webhooks`          |
| WhatsApp      | developers.facebook.com/documentation/business-messaging/whatsapp: `send-messages`, `templates/overview`, `messaging-limits`, `webhooks`, `access-tokens`, `whatsapp-business-phone-number`           |

Versión de Graph API: `v27.0`, la de los ejemplos oficiales (`META_GRAPH_VERSION`).

## Estados y modos

| Estado           | Significado                                                                          |
| ---------------- | ------------------------------------------------------------------------------------ |
| `NOT_CONFIGURED` | Faltan secrets o autorización. El detalle indica qué falta                           |
| `CONNECTED`      | Verificado contra la API (`/users/me`, `/me`, `/{phone-number-id}`), o tienda propia |
| `EXPIRED`        | Token vencido o rechazado (401/403). Se intenta renovar si el canal lo soporta       |
| `ERROR`          | La API falló o respondió con un formato inesperado                                   |
| `DISABLED`       | Deshabilitada por el usuario: toda operación se rechaza                              |

**LIVE** usa la API oficial real.

**MOCK** envuelve al adaptador real y hereda sus capacidades:

- no hace llamadas de red ni usa credenciales;
- los IDs externos empiezan con `mock-`;
- no inventa pedidos ni datos financieros, solo devuelve los _fixtures_ explícitos de un test;
- en el dashboard se muestra como **MOCK · simulado**;
- una publicación MOCK nunca aparece en la tienda pública.

## Interfaz común (`packages/integrations/src/channels/types.ts`)

Métodos: `connect`, `disconnect`, `getConnectionStatus`, `refreshTokens`, `getCatalog`,
`createListing`, `updateListing`, `pauseListing`, `getOrders`, `getOrderStatus`,
`handleWebhook`.

Cada adaptador declara además `capabilities`, que el dashboard muestra con la nota de la
fuente. Cada operación se marca de una de tres formas:

- **API oficial:** la operación existe en la API del canal.
- **Local:** se resuelve en nuestro sistema.
- **No soportado:** la API no la ofrece.

| Operación | Mercado Libre                                      | Instagram                                     | WhatsApp                               | Tienda propia     | Afiliados         |
| --------- | -------------------------------------------------- | --------------------------------------------- | -------------------------------------- | ----------------- | ----------------- |
| connect   | OAuth 2.0 + PKCE S256 + state                      | OAuth Instagram Login → token de 60 días      | Token del sistema + ID del número      | Local             | No soportado      |
| refresh   | `refresh_token` de un solo uso                     | `ig_refresh_token` (con ≥ 24 h de antigüedad) | No soportado (token de larga duración) | —                 | —                 |
| status    | `GET /users/me`                                    | `GET /me`                                     | `GET /{phone-number-id}`               | Local             | `NOT_CONFIGURED`  |
| catalog   | `/users/{id}/items/search` + `/items/{id}`         | `GET /{ig-id}/media`                          | No soportado                           | Local             | Sin conector      |
| create    | `POST /items`                                      | contenedor → `status_code` → `media_publish`  | No soportado                           | Local             | Enlace (local)    |
| update    | `PUT /items/{id}`                                  | **No soportado** (doc: "not supported")       | No soportado                           | Local             | Sin conector      |
| pause     | `PUT /items/{id}` `status: paused`                 | **No soportado**                              | No soportado                           | Local             | Desactivar enlace |
| orders    | `/orders/search?seller=`, `/orders/{id}`           | **No soportado**                              | No soportado                           | Requiere checkout | Conversiones      |
| webhooks  | Sin firma: `application_id` + consulta del recurso | `X-Hub-Signature-256`                         | `X-Hub-Signature-256`                  | Vía checkout      | Sin conector      |

Extras por canal:

- **Mercado Libre:** preguntas (`GET /questions/search?seller_id=…&api_version=4`) y
  respuestas (`POST /answers`, máximo 2000 caracteres).
- **WhatsApp:** envío con `POST /{phone-number-id}/messages`, de texto o con plantilla.

## Seguridad

- **Tokens:** se cifran con AES-256-GCM. La clave es `TOKEN_ENCRYPTION_KEY` (un secret) y el
  AAD queda atado a la conexión. Los tokens nunca se devuelven por la API ni se loguean.
  Desconectar borra los tokens locales.
- **OAuth:**
  - El `state` es aleatorio y de un solo uso; se guarda su hash y vence a los 10 minutos.
    Se consume de forma atómica, así que repetirlo devuelve 401.
  - El PKCE `code_verifier` se guarda cifrado.
  - El `redirect_uri` es fijo: `${PUBLIC_API_URL}/oauth/callback/{mercadolibre|instagram}`.
- **Webhooks de Meta:** la firma HMAC-SHA256 del cuerpo crudo se compara en tiempo
  constante. El GET de suscripción valida `hub.verify_token`.
- **Webhooks de Mercado Libre:** no vienen firmados.
  - Se acepta la notificación solo si `application_id` coincide con `ML_APP_ID`.
  - El procesamiento **no confía** en su contenido: vuelve a consultar el recurso con
    nuestro token, como indica la documentación.
- **Idempotencia:**
  - Los webhooks llevan un índice único `(canal, dedupe_key)`. Mercado Libre usa `_id`, o
    en su defecto `topic|resource|received`. WhatsApp usa el `wamid` más el estado.
  - Las publicaciones usan `idempotency_key`.
  - Las conversiones de afiliados usan la referencia de la red.
  - Los trabajos usan `webhook:<id>`.
- **Registro de errores:** `integration_logs` guarda la operación, el resultado
  (OK/ERROR/BLOCKED/UNSUPPORTED), el código, el HTTP y la duración, sin secretos.
- **Rate limiting:** ventanas fijas persistidas en D1 (`rate_limit_windows`). Los 429 del
  canal se convierten en `RATE_LIMITED`.
  - Instagram: **50 publicaciones cada 24 h**. Es el valor conservador: la misma página
    oficial dice 50 y 100.
  - WhatsApp: **250 destinatarios únicos cada 24 h** fuera de la ventana de servicio, que es
    el nivel inicial.
  - Mercado Libre: no documenta un número. Usamos un límite propio de 600 por minuto y se
    respeta el 429 `local_rate_limited`.

## Publicación automática

`evaluatePublishGate` (en `packages/business-rules`) exige **todas** estas condiciones:

1. Proveedor `VERIFIED`.
2. Stock verificable: disponible y con control vigente.
3. Margen ≥ `MIN_NET_MARGIN_BPS`.
4. Capacidad logística: despacho directo y plazos cargados.
5. Políticas del canal y compliance del contenido.
6. Risk Guardian aprueba.
7. Integración autorizada: LIVE, `CONNECTED` y con los permisos de publicación.
8. `COMMERCIAL_ACTIONS_ENABLED=true`.

El gate se evalúa al preparar la publicación y **otra vez justo antes de publicar**. El
puntaje del producto no participa.

El agente `channels.auto_publish` intenta publicar las publicaciones `READY`, y cada una
pasa por el gate. Con el interruptor apagado, ninguna sale en LIVE.

En MOCK la publicación se simula si se cumplen las condiciones 1 a 6.

Políticas por canal codificadas (solo reglas documentadas):

- **Mercado Libre:** categoría, tipo de publicación y condición obligatorios (no se
  inventan valores por defecto), ARS, al menos 1 unidad y al menos 1 imagen.
- **Instagram:** solo JPEG en URL pública, caption ≤ 2200 caracteres, ≤ 30 hashtags,
  ≤ 20 menciones, carrusel ≤ 20. El carrusel todavía no está implementado.

Las imágenes sin autorización registrada nunca se incluyen en el borrador.

## Tienda propia

- **Catálogo público:** `GET /store/{slug}/products`.
- **Página de producto:** `GET /store/{slug}/p/{listingId}`, en HTML escapado.
- **Vista previa:** `GET /v1/channels/listings/{id}/preview`, con aviso de que el producto
  no está a la venta.
- **Checkout separado:** el contrato es `CheckoutProvider` y hoy está configurado
  `notConfiguredCheckout`, así que `POST /store/{slug}/checkout` responde **503**. **No se
  simulan pagos.** Integrar una pasarela requiere especificarla primero.

## Afiliados

Ninguna red está especificada todavía, así que las operaciones externas quedan
`NOT_CONFIGURED`. La gestión es local:

- **Redes y productos:** la tasa de comisión exige su fuente.
- **Enlaces:** el destino es el enlace https que emite la red. No se fabrica.
- **Clics:** `GET /r/{code}` registra el clic y redirige **solo** al destino registrado. Se
  guardan el host de referencia y el país de Cloudflare, sin IP.
- **Conversiones:** llevan respaldo (`sourceRef`), no aceptan fechas futuras y no se
  duplican.
- **Comisiones:** si no viene el dato de la red, se calcula con la tasa respaldada,
  redondeando hacia abajo. Si no hay tasa, se pide el dato.
- **Resumen:** si no hay clics, la tasa de conversión es `null`.

## Webhooks y procesamiento

`POST /webhooks/{mercadolibre|instagram|whatsapp}` (y `GET` para la verificación de Meta):

1. Valida la firma o el `application_id`.
2. Guarda el evento, ya redactado, con su clave de idempotencia.
3. Mapea la cuenta externa a su conexión. Si no hay conexión, el evento queda `IGNORED`.
4. Crea el trabajo `channels.webhook_process`, de prioridad comercial, y responde de
   inmediato. Mercado Libre exige HTTP 200 en menos de 500 ms.

El trabajo hace, según el canal:

- **Mercado Libre `orders_v2`:** `GET /orders/{id}` y actualiza el pedido.
- **WhatsApp `messages`:** registra el mensaje entrante, usando el BSUID antes que el
  teléfono.
- **WhatsApp `statuses`:** actualiza el estado del mensaje saliente.

El agente `channels.connection_check` verifica las conexiones LIVE y renueva los tokens
vencidos.

## Mensajes (WhatsApp / preguntas de Mercado Libre)

Se preparan como borradores. Enviar es la acción comercial `send_customer_message`: con el
interruptor apagado el mensaje queda `BLOCKED`.

WhatsApp:

- El texto libre solo se acepta dentro de las 24 h desde el último mensaje del cliente;
  fuera de esa ventana, solo plantillas aprobadas.
- El `wamid` solo significa que la API aceptó el mensaje. La entrega se confirma por
  webhook.

## Secrets (`wrangler secret put` / `apps/api/.dev.vars`)

Todos son opcionales: sin ellos, el canal queda `NOT_CONFIGURED`.

| Secret                                      | Uso                                                    |
| ------------------------------------------- | ------------------------------------------------------ |
| `TOKEN_ENCRYPTION_KEY`                      | 32 bytes en base64 (`openssl rand -base64 32`)         |
| `PUBLIC_API_URL`                            | URL pública de la API, para el `redirect_uri` de OAuth |
| `ML_APP_ID` / `ML_CLIENT_SECRET`            | App de Mercado Libre                                   |
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | App de Instagram (también firma sus webhooks)          |
| `META_APP_SECRET`                           | Firma de los webhooks de WhatsApp                      |
| `META_WEBHOOK_VERIFY_TOKEN`                 | Verify token elegido al suscribir los webhooks de Meta |

El token de WhatsApp **no** es un secret del Worker. Lo carga el negocio desde el
dashboard, se valida contra la API y se guarda cifrado.

## Pendiente / a especificar

- **Estados de órdenes de Mercado Libre:** la página de órdenes los enlaza aparte. Por ahora
  `paid` está verificado y el resto se mapea con fallback `OTHER`, conservando `rawStatus`.
- **Instagram:** falta confirmar el valor de `object` en sus webhooks. Por eso se aceptan
  genéricamente y quedan registrados.
- **A especificar antes de integrar:** carruseles de Instagram, catálogo de WhatsApp,
  pasarela de checkout y redes de afiliados concretas.

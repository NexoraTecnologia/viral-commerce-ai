# Seguridad

## Principios

1. **Mínimo privilegio y lista blanca por defecto** (CORS, roles, bindings).
2. **Validación en todos los bordes** con Zod: HTTP, colas, integraciones, entorno.
3. **Secretos fuera del repositorio**, siempre.
4. **Modo simulación por defecto**: `COMMERCIAL_ACTIONS_ENABLED=false`.
5. **Auditoría**: acciones relevantes quedan en `audit_events` (append-only).

## Secretos

| Entorno    | Dónde                                     |
| ---------- | ----------------------------------------- |
| Local      | `apps/api/.dev.vars` (ignorado por git)   |
| Cloudflare | `wrangler secret put NOMBRE`              |
| CI         | GitHub Actions Secrets (cuando exista CI) |

Prohibido: commitear `.env`, `.dev.vars`, tokens, claves o credenciales de prueba
que parezcan reales. `.env.example` y `.dev.vars.example` contienen solo nombres.

## Controles implementados

- Cabeceras seguras (`hono/secure-headers`): `nosniff`, `X-Frame-Options`, HSTS, etc.
- CORS con lista blanca exacta (`@vc/security` → `isOriginAllowed`); sin comodines.
- Errores al cliente sin stack ni detalles internos.
- `timingSafeEqual` y `verifyHmacSignature` para tokens y webhooks.
- `redact()` para logs: oculta password, token, api key, cookie, CUIT/CUIL/DNI, tarjeta.
- Guardia de acciones comerciales (`assertCommercialActionAllowed`).
- Tests de arquitectura que impiden que el dashboard importe código de servidor.

## Pendiente

- **Contexto de tenant temporal:** el header `X-Tenant-Id` solo se acepta con
  `APP_ENV=development`; en staging/production la API responde 401. Debe
  reemplazarse por autenticación real antes de cualquier despliegue (Fase 2).

- Autenticación y autorización por rol (Fase 2).
- Rate limiting (evaluar opciones gratuitas de Cloudflare).
- Política de retención de datos personales conforme a la Ley 25.326 (Argentina).
- Escaneo de dependencias en CI (`npm audit`, Dependabot gratuito).

## Reportar vulnerabilidades

Reportar de forma privada al responsable del repositorio. No abrir issues públicos
con detalles explotables.

## Tokens de integraciones

- Cifrados en reposo (AES-256-GCM, clave `TOKEN_ENCRYPTION_KEY` en secret, AAD por conexión).
- Nunca se devuelven por la API ni se escriben en logs; desconectar borra los tokens locales.
- OAuth con `state` de un solo uso (hash en D1, 10 min) y PKCE S256.
- Webhooks de Meta validados con `X-Hub-Signature-256` (comparación en tiempo constante);
  notificaciones de Mercado Libre validadas por `application_id` y re-consulta del recurso.
- Detalle en [docs/CHANNELS.md](docs/CHANNELS.md).

## Modo de entorno (fail-closed)

`APP_ENV` es `production` por defecto: fuera de desarrollo todo `/v1` exige autenticación
(hoy inexistente → 401). El modo desarrollo solo se activa con `npm run dev:api`
(`--var APP_ENV:development`). Nunca desplegar con `APP_ENV=development`.
Ver [AUDIT_REPORT.md](AUDIT_REPORT.md).

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

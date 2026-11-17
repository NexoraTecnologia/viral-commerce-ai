# Despliegue

> **Estado: NO desplegado.** Nada en este repositorio se despliega automáticamente.
> El primer despliegue requiere pedido explícito y el checklist completo.

## Objetivo (plan Cloudflare Free)

| Componente       | Destino                                                    |
| ---------------- | ---------------------------------------------------------- |
| `apps/api`       | Cloudflare Worker `viralcommerce-api`                      |
| `apps/dashboard` | Cloudflare Pages (o Workers Static Assets), build `dist/`  |
| Base de datos    | D1 `viralcommerce-db`                                      |
| Colas            | Queues `viralcommerce-jobs` + DLQ `viralcommerce-jobs-dlq` |

Verificar en la documentación oficial que cada producto siga incluido en el plan
Free y sus límites vigentes antes de crear recursos.

## Verificación de build sin desplegar

```bash
npm run build
```

Para la API ejecuta `wrangler deploy --dry-run --outdir dist`: empaqueta y valida
la configuración **sin subir nada**.

## Checklist del primer despliegue

- [ ] `npm run check` en verde
- [ ] Recursos creados según `infrastructure/cloudflare/setup.md`
- [ ] `database_id` real en `apps/api/wrangler.jsonc`
- [ ] Migraciones aplicadas con `--remote`
- [ ] `APP_ENV` y `ALLOWED_ORIGINS` correctos por entorno (usar `env.staging` / `env.production` en wrangler)
- [ ] `COMMERCIAL_ACTIONS_ENABLED="false"`
- [ ] Secretos cargados con `wrangler secret put`
- [ ] `workers_dev` revisado (hoy `false`) y ruta/dominio definido

## Comandos (cuando se autorice)

```bash
npm run deploy -w @vc/api
```

(El script `deploy` aún no existe a propósito; se agregará en la Fase 5.)

## Rollback

Workers mantiene versiones: `wrangler rollback` vuelve a la versión anterior.
Las migraciones D1 no se revierten automáticamente; diseñarlas compatibles hacia atrás.

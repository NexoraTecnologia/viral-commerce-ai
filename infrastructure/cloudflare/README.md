# Infraestructura Cloudflare

Recursos previstos (todos dentro del plan **Free**; verificar límites vigentes en
la documentación oficial antes de crear cada uno):

| Recurso        | Nombre                    | Uso                                | Config                    |
| -------------- | ------------------------- | ---------------------------------- | ------------------------- |
| Worker         | `viralcommerce-api`       | API HTTP + consumidor de colas     | `apps/api/wrangler.jsonc` |
| D1             | `viralcommerce-db`        | Base de datos relacional           | binding `DB`              |
| Queue          | `viralcommerce-jobs`      | Trabajos asíncronos                | binding `JOBS_QUEUE`      |
| Queue (DLQ)    | `viralcommerce-jobs-dlq`  | Mensajes fallidos tras reintentos  | `dead_letter_queue`       |
| Pages / Assets | `viralcommerce-dashboard` | Frontend estático (apps/dashboard) | ver docs/DEPLOYMENT.md    |

**Estado actual:** ningún recurso creado. No desplegar hasta completar el
checklist de `docs/DEPLOYMENT.md`.

Los comandos de creación están en [`setup.md`](./setup.md).

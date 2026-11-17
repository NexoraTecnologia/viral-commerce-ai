# Creación de recursos (NO ejecutar todavía)

Estos comandos crean recursos reales en la cuenta de Cloudflare. Ejecutarlos solo
cuando el roadmap habilite el primer despliegue y con aprobación explícita.

```bash
npx wrangler login
```

```bash
npx wrangler d1 create viralcommerce-db
```

Copiar el `database_id` devuelto en `apps/api/wrangler.jsonc`.

```bash
npx wrangler queues create viralcommerce-jobs
```

```bash
npx wrangler queues create viralcommerce-jobs-dlq
```

```bash
npx wrangler d1 migrations apply viralcommerce-db --remote --config apps/api/wrangler.jsonc
```

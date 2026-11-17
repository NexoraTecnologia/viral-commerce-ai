import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { appError, err, ok, type AppError, type AppErrorCode, type Result } from '@vc/shared';
import { IdParamSchema } from '@vc/shared';

const STATUS_BY_CODE: Record<AppErrorCode, ContentfulStatusCode> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  COMMERCIAL_ACTIONS_DISABLED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTEGRATION_NOT_CONFIGURED: 503,
  INTERNAL_ERROR: 500,
};

/** Respuesta de error estándar: { error: { code, message, details? } }. */
export const fail = (c: Context, error: AppError) =>
  c.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
    STATUS_BY_CODE[error.code],
  );

/** Responde un Result: ok → JSON con status dado; err → error estándar. */
export const respond = <T>(c: Context, result: Result<T>, status: ContentfulStatusCode = 200) =>
  result.ok ? c.json(result.value as object, status) : fail(c, result.error);

/** Lee y valida el cuerpo JSON con Zod. */
export const readJson = async <S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<Result<z.output<S>>> => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return err(appError('VALIDATION_ERROR', 'El cuerpo debe ser JSON válido'));
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return err(
      appError(
        'VALIDATION_ERROR',
        'Datos inválidos',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      ),
    );
  }
  return ok(parsed.data);
};

/** Valida un parámetro de ruta UUID. IDs mal formados se tratan como inexistentes. */
export const idParam = (c: Context, name: string): Result<string> => {
  const parsed = IdParamSchema.safeParse(c.req.param(name));
  return parsed.success ? ok(parsed.data) : err(appError('NOT_FOUND', 'Recurso no encontrado'));
};

export const iso = (d: Date): string => d.toISOString();
export const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const notFound = (what: string) => err(appError('NOT_FOUND', `${what} no encontrado`));

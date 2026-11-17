import type { z } from 'zod';
import {
  appError,
  CHANNEL_OPERATIONS,
  err,
  ok,
  type Capability,
  type ChannelCapabilities,
  type ChannelOperation,
  type Result,
} from '@vc/shared';
import type { AdapterContext } from './types';

export const unsupported = <T>(what: string, note: string): Result<T> =>
  err(appError('UNSUPPORTED_OPERATION', `${what}: ${note}`));

export const notConfigured = <T>(what: string): Result<T> =>
  err(appError('INTEGRATION_NOT_CONFIGURED', what));

export const writesBlocked = <T>(what: string): Result<T> =>
  err(
    appError(
      'COMMERCIAL_ACTIONS_DISABLED',
      `${what} bloqueado: COMMERCIAL_ACTIONS_ENABLED=false (modo simulación)`,
    ),
  );

export const caps = (
  entries: Partial<Record<ChannelOperation, Capability>>,
  fallback: Capability,
): ChannelCapabilities =>
  Object.fromEntries(CHANNEL_OPERATIONS.map((op) => [op, entries[op] ?? fallback])) as Record<
    ChannelOperation,
    Capability
  >;

export const S = (note: string): Capability => ({ support: 'SUPPORTED', note });
export const U = (note: string): Capability => ({ support: 'UNSUPPORTED', note });
export const L = (note: string): Capability => ({ support: 'LOCAL_ONLY', note });

export interface HttpOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly form?: Record<string, string>;
}

/**
 * HTTP con validación Zod de la respuesta y mapeo de errores:
 * 401/403 → UNAUTHORIZED, 429 → RATE_LIMITED, 5xx/red → UPSTREAM_ERROR.
 * Los mensajes de error NO incluyen tokens ni cuerpos con datos sensibles.
 */
export const httpJson = async <S extends z.ZodType>(
  ctx: AdapterContext,
  url: string,
  schema: S,
  options: HttpOptions = {},
): Promise<Result<z.output<S>>> => {
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  let body: string | undefined;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  }
  let res: Response;
  try {
    res = await ctx.fetch(url, { method: options.method ?? 'GET', headers, body: body ?? null });
  } catch {
    return err(appError('UPSTREAM_ERROR', 'No se pudo contactar la API del canal'));
  }
  const safeUrl = url.split('?')[0] ?? url;
  if (res.status === 429) {
    return err(
      appError('RATE_LIMITED', 'El canal limitó las solicitudes (429)', {
        retryAfter: res.headers.get('retry-after'),
      }),
    );
  }
  if (res.status === 401 || res.status === 403) {
    return err(
      appError('UNAUTHORIZED', `El canal rechazó la credencial (${res.status})`, {
        httpStatus: res.status,
      }),
    );
  }
  if (!res.ok) {
    return err(
      appError(
        res.status >= 500 ? 'UPSTREAM_ERROR' : 'VALIDATION_ERROR',
        `El canal respondió ${res.status} en ${safeUrl}`,
        { httpStatus: res.status },
      ),
    );
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return err(appError('UPSTREAM_ERROR', 'Respuesta del canal no es JSON'));
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return err(appError('UPSTREAM_ERROR', 'Respuesta del canal con formato inesperado'));
  }
  return ok(parsed.data);
};

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Precio en centavos → número decimal que esperan las APIs (solo en el borde). */
export const centsToDecimal = (cents: number): number => Math.round(cents) / 100;

export const decimalToCents = (value: number): number => Math.round(value * 100);

export const headerOf = (
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined => {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
};

export const sha256Hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
};

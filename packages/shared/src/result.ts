/**
 * Resultado explícito para operaciones que pueden fallar de forma esperada.
 * Preferir esto a lanzar excepciones en la lógica de negocio.
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = AppError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'COMMERCIAL_ACTIONS_DISABLED'
  | 'INTEGRATION_NOT_CONFIGURED'
  | 'INTERNAL_ERROR';

export interface AppError {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

export const appError = (code: AppErrorCode, message: string, details?: unknown): AppError =>
  details === undefined ? { code, message } : { code, message, details };

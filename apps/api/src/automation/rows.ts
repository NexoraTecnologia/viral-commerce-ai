/**
 * Primera fila o `undefined`. Se usa con UPDATE … RETURNING condicionales
 * (compare-and-set): si la condición no coincide no hay fila, aunque el tipo de
 * `.get()` de Drizzle no lo refleje.
 */
export const firstRow = <T>(rows: readonly T[]): T | undefined => rows[0];

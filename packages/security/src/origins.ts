/** Parsea una lista de orígenes separada por comas y descarta entradas vacías. */
export const parseAllowedOrigins = (raw: string): readonly string[] =>
  raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o.length > 0);

/** Lista blanca estricta: sin comodines. Un origen ausente o "null" nunca se permite. */
export const isOriginAllowed = (
  origin: string | null | undefined,
  allowed: readonly string[],
): boolean => {
  if (!origin || origin === 'null') return false;
  return allowed.includes(origin.replace(/\/+$/, ''));
};

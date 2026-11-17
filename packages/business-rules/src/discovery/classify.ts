/** Normaliza texto en español: minúsculas, sin tildes, solo letras/números. */
export const normalizeText = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const containsTerm = (text: string, term: string): boolean => {
  const t = normalizeText(term);
  return t.length > 0 && ` ${normalizeText(text)} `.includes(` ${t} `);
};

/**
 * Sugiere la categoría cuyo set de palabras clave más coincide con el título.
 * Es una regla determinística (no IA): sin coincidencias devuelve null.
 */
export const suggestCategory = <C extends { id: string; keywords: readonly string[] }>(
  title: string,
  categories: readonly C[],
): C | null => {
  let best: C | null = null;
  let bestHits = 0;
  for (const c of categories) {
    const hits = c.keywords.filter((k) => containsTerm(title, k)).length;
    if (hits > bestHits) {
      best = c;
      bestHits = hits;
    }
  }
  return best;
};

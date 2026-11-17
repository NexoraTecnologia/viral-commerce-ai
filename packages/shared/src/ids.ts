/** Genera un identificador único (UUID v4) usando Web Crypto, disponible en Workers y navegador. */
export const newId = (): string => crypto.randomUUID();

/** Fecha actual en ISO-8601 UTC. Centralizado para poder mockearlo en tests. */
export const nowIso = (): string => new Date().toISOString();

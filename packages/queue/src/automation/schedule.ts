import type { ScheduleFrequency } from '@vc/shared';

/**
 * Cálculo de próximas ejecuciones en una zona horaria IANA.
 *
 * Cloudflare Cron Triggers corren en UTC. Las frecuencias del negocio se definen
 * en hora local (por defecto America/Argentina/Buenos_Aires, hoy UTC−3) y aquí se
 * convierten a instantes UTC usando la base de zonas horarias del runtime (Intl),
 * no el reloj ni la zona del navegador. Si Argentina vuelve a adoptar horario de
 * verano, el cálculo lo refleja sin cambiar código.
 */
export const ARGENTINA_TZ = 'America/Argentina/Buenos_Aires';

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
};

export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
};

/** Fecha y hora de pared de `instant` en `timeZone`. */
export const toLocalParts = (instant: Date, timeZone: string): LocalParts => {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(instant)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  return {
    year: parts['year'] ?? 0,
    month: parts['month'] ?? 0,
    day: parts['day'] ?? 0,
    hour: parts['hour'] ?? 0,
    minute: parts['minute'] ?? 0,
    second: parts['second'] ?? 0,
  };
};

/** Desfase de la zona respecto de UTC en minutos (Argentina: −180). */
export const timeZoneOffsetMinutes = (instant: Date, timeZone: string): number => {
  const p = toLocalParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60_000);
};

/** Instante UTC correspondiente a una fecha y hora de pared en `timeZone`. */
export const zonedTimeToUtc = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date => {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset1 = timeZoneOffsetMinutes(new Date(guess), timeZone);
  let t = guess - offset1 * 60_000;
  const offset2 = timeZoneOffsetMinutes(new Date(t), timeZone);
  if (offset2 !== offset1) t = guess - offset2 * 60_000;
  return new Date(t);
};

const parseLocalTime = (hhmm: string): { hour: number; minute: number } => {
  const [h = '0', m = '0'] = hhmm.split(':');
  return { hour: Number(h), minute: Number(m) };
};

/**
 * Primera ejecución estrictamente posterior a `after`.
 *  - INTERVAL: `after + everyMinutes`.
 *  - DAILY / WEEKLY: próxima ocurrencia de la hora local (y día de semana) en la zona.
 * No hace "backfill": si el sistema estuvo caído, se calcula desde `after`.
 */
export const computeNextRun = (
  frequency: ScheduleFrequency,
  timeZone: string,
  after: Date,
): Date => {
  if (frequency.kind === 'INTERVAL') {
    return new Date(after.getTime() + frequency.everyMinutes * 60_000);
  }
  const { hour, minute } = parseLocalTime(frequency.localTime);
  const local = toLocalParts(after, timeZone);
  for (let i = 0; i <= 7; i++) {
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day + i));
    if (frequency.kind === 'WEEKLY' && !frequency.daysOfWeek.includes(day.getUTCDay())) continue;
    const candidate = zonedTimeToUtc(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  // Inalcanzable con días válidos; protección ante configuración vacía.
  return new Date(after.getTime() + 7 * 86_400_000);
};

/** Formato legible de un instante en la zona (para logs y respuestas). */
export const formatInTimeZone = (instant: Date, timeZone: string): string => {
  const p = toLocalParts(instant, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = timeZoneOffsetMinutes(instant, timeZone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

import { describe, expect, it } from 'vitest';
import { computeBackoffMs } from './backoff';
import {
  breakerDecision,
  breakerOnFailure,
  breakerOnSuccess,
  CLOSED_BREAKER,
} from './circuit-breaker';
import { classifyJobError, JobTimeoutError, PermanentJobError, withTimeout } from './errors';
import { canTransitionJob, isTerminal } from './job-state';
import {
  ARGENTINA_TZ,
  computeNextRun,
  formatInTimeZone,
  timeZoneOffsetMinutes,
  zonedTimeToUtc,
} from './schedule';

describe('zona horaria Argentina', () => {
  it('UTC−3 sin depender del reloj ni zona de la máquina', () => {
    expect(timeZoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), ARGENTINA_TZ)).toBe(-180);
    expect(timeZoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), ARGENTINA_TZ)).toBe(-180);
  });

  it('convierte hora local de Argentina a UTC', () => {
    expect(zonedTimeToUtc(2026, 11, 16, 9, 0, ARGENTINA_TZ).toISOString()).toBe(
      '2026-11-16T12:00:00.000Z',
    );
    // 22:30 ART = 01:30 UTC del día siguiente
    expect(zonedTimeToUtc(2026, 11, 16, 22, 30, ARGENTINA_TZ).toISOString()).toBe(
      '2026-11-17T01:30:00.000Z',
    );
  });

  it('formatea en hora local con desfase explícito', () => {
    expect(formatInTimeZone(new Date('2026-11-17T01:30:00Z'), ARGENTINA_TZ)).toBe(
      '2026-11-16T22:30:00-03:00',
    );
  });
});

describe('computeNextRun', () => {
  it('INTERVAL suma minutos', () => {
    const after = new Date('2026-11-16T12:00:00Z');
    expect(computeNextRun({ kind: 'INTERVAL', everyMinutes: 15 }, ARGENTINA_TZ, after)).toEqual(
      new Date('2026-11-16T12:15:00Z'),
    );
  });

  it('DAILY 09:00 ART: hoy si todavía no pasó, mañana si ya pasó', () => {
    const daily = { kind: 'DAILY', localTime: '09:00' } as const;
    // 08:00 ART
    expect(computeNextRun(daily, ARGENTINA_TZ, new Date('2026-11-16T11:00:00Z'))).toEqual(
      new Date('2026-11-16T12:00:00Z'),
    );
    // 09:00 ART exacto ⇒ estrictamente posterior ⇒ mañana
    expect(computeNextRun(daily, ARGENTINA_TZ, new Date('2026-11-16T12:00:00Z'))).toEqual(
      new Date('2026-11-17T12:00:00Z'),
    );
  });

  it('DAILY respeta el día local aunque en UTC ya sea el día siguiente', () => {
    // 23:00 ART del 16 = 02:00 UTC del 17. Próximas 23:30 ART siguen siendo el 16.
    const next = computeNextRun(
      { kind: 'DAILY', localTime: '23:30' },
      ARGENTINA_TZ,
      new Date('2026-11-17T02:00:00Z'),
    );
    expect(next).toEqual(new Date('2026-11-17T02:30:00Z'));
  });

  it('WEEKLY elige el próximo día habilitado (local)', () => {
    // 2026-11-16 es lunes. Próximo miércoles (3) 10:00 ART = 13:00 UTC del 18.
    const next = computeNextRun(
      { kind: 'WEEKLY', localTime: '10:00', daysOfWeek: [3] },
      ARGENTINA_TZ,
      new Date('2026-11-16T15:00:00Z'),
    );
    expect(next).toEqual(new Date('2026-11-18T13:00:00Z'));
  });
});

describe('backoff', () => {
  it('crece exponencialmente con tope y es determinístico', () => {
    const a1 = computeBackoffMs(1, 'job');
    const a2 = computeBackoffMs(2, 'job');
    expect(a1).toBeGreaterThanOrEqual(30_000);
    expect(a1).toBeLessThan(36_000);
    expect(a2).toBeGreaterThanOrEqual(60_000);
    expect(computeBackoffMs(30, 'job')).toBe(3_600_000);
    expect(computeBackoffMs(2, 'job')).toBe(a2);
  });
});

describe('circuit breaker', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  const policy = { failureThreshold: 3, cooldownMs: 60_000 };

  it('abre tras N fallas, deja probar tras el cooldown y cierra con éxito', () => {
    let b = CLOSED_BREAKER;
    b = breakerOnFailure(b, now, policy);
    b = breakerOnFailure(b, now, policy);
    expect(b.state).toBe('CLOSED');
    b = breakerOnFailure(b, now, policy);
    expect(b.state).toBe('OPEN');

    expect(breakerDecision(b, new Date(now.getTime() + 30_000)).allowed).toBe(false);
    const later = breakerDecision(b, new Date(now.getTime() + 60_000));
    expect(later.allowed).toBe(true);
    expect(later.state.state).toBe('HALF_OPEN');

    expect(breakerOnFailure(later.state, now, policy).state).toBe('OPEN');
    expect(breakerOnSuccess().state).toBe('CLOSED');
  });
});

describe('errores y timeouts', () => {
  it('clasifica errores', () => {
    expect(classifyJobError(new PermanentJobError('x'))).toBe('PERMANENT');
    expect(classifyJobError(new JobTimeoutError(10))).toBe('TIMEOUT');
    expect(classifyJobError(new Error('red'))).toBe('RECOVERABLE');
  });

  it('withTimeout corta trabajos colgados', async () => {
    const never = () => new Promise<never>(() => undefined);
    await expect(withTimeout(never, 5, () => Promise.resolve())).rejects.toBeInstanceOf(
      JobTimeoutError,
    );
  });

  it('withTimeout devuelve el resultado si termina a tiempo', async () => {
    const slowSleep = () => new Promise<void>(() => undefined);
    await expect(withTimeout(() => Promise.resolve(42), 5, slowSleep)).resolves.toBe(42);
  });
});

describe('estados de trabajos', () => {
  it('valida transiciones', () => {
    expect(canTransitionJob('PENDING', 'RUNNING')).toBe(true);
    expect(canTransitionJob('COMPLETED', 'RUNNING')).toBe(false);
    expect(canTransitionJob('DEAD_LETTER', 'RETRYING')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('RETRYING')).toBe(false);
  });
});

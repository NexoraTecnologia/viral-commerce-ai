import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from '@vc/shared';
import { createApp } from './app';
import type { Env } from './env';

const env = {
  APP_ENV: 'development',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  COMMERCIAL_ACTIONS_ENABLED: 'false',
} as unknown as Env;

describe('API', () => {
  const app = createApp();

  it('GET /health responde con el contrato compartido', async () => {
    const res = await app.request('/health', {}, env);
    expect(res.status).toBe(200);
    const body = HealthResponseSchema.parse(await res.json());
    expect(body.commercialActionsEnabled).toBe(false);
  });

  it('agrega cabeceras de seguridad', async () => {
    const res = await app.request('/health', {}, env);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('CORS solo para orígenes permitidos', async () => {
    const okRes = await app.request(
      '/health',
      { headers: { Origin: 'http://localhost:5173' } },
      env,
    );
    expect(okRes.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

    const badRes = await app.request('/health', { headers: { Origin: 'https://evil.test' } }, env);
    expect(badRes.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('404 con formato de error estándar', async () => {
    const res = await app.request('/no-existe', {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' },
    });
  });
});

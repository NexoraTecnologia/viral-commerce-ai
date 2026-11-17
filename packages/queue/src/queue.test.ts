import { describe, expect, it, vi } from 'vitest';
import { createMessage, dispatchMessage, type HandlerMap } from './index';

describe('queue dispatcher', () => {
  it('despacha mensajes válidos', async () => {
    const ping = vi.fn(() => Promise.resolve());
    const handlers: HandlerMap = { 'system.ping': ping };
    const msg = createMessage('system.ping', { note: 'hola' });

    const outcome = await dispatchMessage(msg, handlers);

    expect(outcome).toEqual({ status: 'handled', type: 'system.ping' });
    expect(ping).toHaveBeenCalledWith(msg);
  });

  it('rechaza mensajes inválidos sin llamar handlers', async () => {
    const ping = vi.fn(() => Promise.resolve());
    const outcome = await dispatchMessage({ type: 'system.ping' }, { 'system.ping': ping });
    expect(outcome.status).toBe('invalid');
    expect(ping).not.toHaveBeenCalled();
  });
});

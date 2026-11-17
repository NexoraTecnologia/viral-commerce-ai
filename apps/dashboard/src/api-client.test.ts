import { describe, expect, it } from 'vitest';
import { buildApiUrl } from './api-client';

describe('buildApiUrl', () => {
  it('une base y ruta sin barras duplicadas', () => {
    expect(buildApiUrl('/api/', '/health')).toBe('/api/health');
    expect(buildApiUrl('https://api.example.com', 'health')).toBe('https://api.example.com/health');
  });
});

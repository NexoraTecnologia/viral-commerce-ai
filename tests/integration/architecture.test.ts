import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Pruebas de arquitectura: protegen las reglas de dependencias entre módulos
 * definidas en docs/ARCHITECTURE.md.
 */
const root = join(import.meta.dirname, '..', '..');

const readPkg = (dir: string): { name: string; dependencies?: Record<string, string> } =>
  JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as {
    name: string;
    dependencies?: Record<string, string>;
  };

const packages = readdirSync(join(root, 'packages')).map((p) => readPkg(join('packages', p)));

describe('reglas de dependencias', () => {
  it('ningún paquete depende de una app', () => {
    for (const pkg of packages) {
      const deps = Object.keys(pkg.dependencies ?? {});
      expect(
        deps.filter((d) => d === '@vc/api' || d === '@vc/dashboard'),
        pkg.name,
      ).toEqual([]);
    }
  });

  it('@vc/shared no depende de otros paquetes internos', () => {
    const shared = packages.find((p) => p.name === '@vc/shared');
    expect(Object.keys(shared?.dependencies ?? {}).filter((d) => d.startsWith('@vc/'))).toEqual([]);
  });

  it('el dashboard no importa paquetes de servidor', () => {
    const deps = Object.keys(readPkg('apps/dashboard').dependencies ?? {});
    for (const forbidden of ['@vc/database', '@vc/queue', '@vc/integrations']) {
      expect(deps).not.toContain(forbidden);
    }
  });
});

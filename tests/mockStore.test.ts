import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFixtureAccounts } from '../src/mock/excelLoader';
import { MockStore } from '../src/mock/mockStore';
import {
  MockAccountRepositories,
  toSafeAccount,
} from '../src/mock/repositories';

const FIXTURE = resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx');

function tmpState(): string {
  return join(mkdtempSync(join(tmpdir(), 'vokath-mock-')), 'mock-state.json');
}

describe('MockStore + repositories (RED: fixture→store→safe seam)', () => {
  it('creates from the fixture when no snapshot exists (117 rows)', async () => {
    const store = await MockStore.create({ fixturePath: FIXTURE, statePath: tmpState() });
    expect(store.accounts.length).toBe(65 + 52);
  });

  it('prefers the snapshot file when it exists', async () => {
    const statePath = tmpState();
    const first = await MockStore.create({ fixturePath: FIXTURE, statePath });
    expect(first.accounts.length).toBe(117);
    const second = await MockStore.create({ fixturePath: FIXTURE, statePath });
    expect(second.accounts.length).toBe(117);
    expect(second.accounts[0]).toEqual(first.accounts[0]);
  });

  it('searches by name (case-insensitive) and by phone digits', async () => {
    const store = await MockStore.create({ fixturePath: FIXTURE, statePath: tmpState() });
    const byName = store.search('anny tovar');
    expect(byName.length).toBeGreaterThan(0);
    expect(byName[0]?.nombre).toBe('Anny Tovar');

    const byPhone = store.search('414 546 0657');
    expect(byPhone.some((row) => row.nombre === 'Anny Tovar')).toBe(true);

    expect(store.search('')).toEqual([]);
    expect(store.search('zzz-no-such-customer-zzz')).toEqual([]);
  });

  it('exposes expired rows and per-service inventory', async () => {
    const store = await MockStore.create({ fixturePath: FIXTURE, statePath: tmpState() });
    expect(store.getExpired().length).toBeGreaterThan(0);
    expect(store.getExpired().every((row) => row.estatus.toUpperCase() !== 'VIGENTE')).toBe(true);
    expect(store.countByService()).toEqual(
      expect.arrayContaining([
        { servicio: 'flujotv', total: 65 },
        { servicio: 'netflix', total: 52 },
      ]),
    );
  });

  it('toSafeAccount strips CORREO/CONTRASEÑA by construction', async () => {
    const store = await MockStore.create({ fixturePath: FIXTURE, statePath: tmpState() });
    const repos = new MockAccountRepositories(store);
    const rows = await repos.searchAccounts('Anny Tovar');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['estatus', 'nombre', 'pais', 'perfil', 'servicio'].sort(),
      );
    }
    const raw = store.search('Anny Tovar')[0];
    expect(raw).toBeDefined();
    expect(toSafeAccount(raw!)).not.toHaveProperty('correo');
    expect(toSafeAccount(raw!)).not.toHaveProperty('contrasena');
    expect(JSON.stringify(rows)).not.toContain(raw?.contrasena ?? 'impossible-marker');
  });

  it('demoSearch consumes the repo seam with safe rows when provided', async () => {
    const { createMockRegistry } = await import('../src/tools/mockTools');
    const store = await MockStore.create({ fixturePath: FIXTURE, statePath: tmpState() });
    const registry = createMockRegistry(new MockAccountRepositories(store));
    const result = (await registry.run('demoSearch', { query: 'Anny' }, 111)) as {
      ok: boolean;
      mock: boolean;
      rows: Array<Record<string, unknown>>;
    };
    expect(result).toMatchObject({ ok: true, mock: true });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.rows)).not.toContain('CONTRASEÑA');
    expect(result.rows[0]).not.toHaveProperty('contrasena');
  });

  it('loads the same rows the loader produces (no drift)', async () => {
    const store = await MockStore.create({ fixturePath: FIXTURE, statePath: tmpState() });
    expect(store.accounts).toEqual(loadFixtureAccounts(FIXTURE));
  });
});

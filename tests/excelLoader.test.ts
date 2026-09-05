import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFixtureAccounts } from '../src/mock/excelLoader';

const FIXTURE = resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx');

describe('excelLoader (RED: fixture sheets load read-only, normalized)', () => {
  it('loads both sheets with normalized columns and servicio tags', () => {
    const accounts = loadFixtureAccounts(FIXTURE);
    const flujotv = accounts.filter((row) => row.servicio === 'flujotv');
    const netflix = accounts.filter((row) => row.servicio === 'netflix');

    expect(flujotv.length).toBe(65);
    expect(netflix.length).toBe(52);

    const sample = flujotv[0];
    expect(sample).toBeDefined();
    expect(sample?.nombre).toBe('Anny Tovar');
    expect(sample?.numero).toBe('4145460657');
    expect(sample?.pais).toBe('VE');
    expect(sample?.fechaInicio).toBe('2026-08-20');
    expect(sample?.fechaFin).toBe('2026-09-07');
  });

  it('excludes identity-less formula residue (DIAS=-46270 rows)', () => {
    const accounts = loadFixtureAccounts(FIXTURE);
    expect(accounts.length).toBe(65 + 52);
    for (const account of accounts) {
      expect(
        account.nombre !== '' || account.correo !== '' || account.numero !== '',
      ).toBe(true);
    }
  });
  it('never modifies the fixture file (read-only)', () => {
    const before = statSync(FIXTURE);
    loadFixtureAccounts(FIXTURE);
    loadFixtureAccounts(join(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'));
    const after = statSync(FIXTURE);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('fails fast when a required sheet is missing', () => {
    expect(() => loadFixtureAccounts(resolve(process.cwd(), 'package.json'))).toThrow();
  });
});

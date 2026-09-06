import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MockAccount } from '../src/mock/excelLoader';
import { MockStore } from '../src/mock/mockStore';
import { normalizePhoneKeys, phonesMatch } from '../src/mock/phone';

const FIXTURE = resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx');

function row(nombre: string, numero: string): MockAccount {
  return {
    servicio: 'flujotv',
    correo: '',
    contrasena: '',
    perfil: 'perfil-1',
    fechaInicio: null,
    fechaFin: null,
    dias: null,
    estatus: 'VIGENTE',
    nombre,
    monto: null,
    estado: '',
    numero,
    pais: 'Venezuela',
  };
}

/**
 * Two DISTINCT, valid VE lines sharing the same last 7 digits
 * (`5460657`): `0414-5460657` → +584145460657 vs `4245460657` →
 * +584245460657 per libphonenumber-js. Under the old global
 * last7==last7 rule the second collided with the first's trunk form
 * (`04245460657` ends with `4245460657`); under exact-key identity
 * they never share a key.
 */
async function twinStore(): Promise<MockStore> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-phone-id-'));
  const statePath = join(dir, 'mock-state.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      accounts: [row('Ana Torres', '0414-5460657'), row('Bruno Diaz', '4245460657')],
    }),
    'utf8',
  );
  return MockStore.create({ fixturePath: FIXTURE, statePath });
}

describe('phone identity: E.164-first, never last-7', () => {
  it('VE legacy variants share one E.164 key (region default, metadata-gated)', () => {
    const bare = normalizePhoneKeys('4242030438');
    const trunk = normalizePhoneKeys('04242030438');
    const intl = normalizePhoneKeys('+584242030438');
    for (const keys of [bare, trunk]) {
      expect(keys).toContain('584242030438');
    }
    expect(intl).toContain('584242030438');
    expect(phonesMatch(bare, trunk)).toBe(true);
    expect(phonesMatch(trunk, intl)).toBe(true);
  });

  it('distinct numbers with the same last 7 digits share NO key', () => {
    const anny = normalizePhoneKeys('0414-5460657');
    const other = normalizePhoneKeys('4245460657');
    expect(anny).not.toEqual([]);
    expect(other).not.toEqual([]);
    expect(anny.some((key) => other.includes(key))).toBe(false);
    expect(phonesMatch(other, anny)).toBe(false);
    expect(phonesMatch(anny, other)).toBe(false);
  });

  it('unparseable legacy digits match only on identical strings (tier 3)', () => {
    const keys = normalizePhoneKeys('ABC-1234567');
    expect(keys).toContain('1234567');
    expect(phonesMatch(keys, ['1234567'])).toBe(true);
    expect(phonesMatch(keys, ['7654321'])).toBe(false);
  });

  it('REGRESSION: full-number search hits only its own row (store choke point)', async () => {
    const store = await twinStore();
    expect(store.search('4245460657').map((account) => account.nombre)).toEqual([
      'Bruno Diaz',
    ]);
    expect(store.search('0414-5460657').map((account) => account.nombre)).toEqual([
      'Ana Torres',
    ]);
    expect(store.search('+58 424-5460657').map((account) => account.nombre)).toEqual([
      'Bruno Diaz',
    ]);
  });

  it('ambiguity returns ALL candidates, never one arbitrary pick', async () => {
    const store = await twinStore();
    const rows = store.search('5460657');
    expect(rows.map((account) => account.nombre).sort()).toEqual([
      'Ana Torres',
      'Bruno Diaz',
    ]);
  });
});

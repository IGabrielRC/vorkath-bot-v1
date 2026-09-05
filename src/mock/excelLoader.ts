import XLSX from 'xlsx';

/**
 * Read-only Excel fixture loader (MOCK plane).
 *
 * Reads `fixtures/BASE PRUEBA_v2.xlsx` with the two sheets
 * `Base FLUJOTV` and `Base NETFLIX` and normalizes every row into a
 * `MockAccount`. The workbook is opened read-only and is NEVER modified.
 *
 * Security: rows carry CORREO/CONTRASEÑA in memory for the MOCK store,
 * but NOTHING here logs them — callers must project through
 * `toSafeAccount` (see `repositories.ts`) before replying or logging.
 * Source: SheetJS `XLSX.readFile` + `sheet_to_json`
 * (https://docs.sheetjs.com/docs/api/utilities/array/).
 */

export type MockService = 'flujotv' | 'netflix';

export interface MockAccount {
  servicio: MockService;
  correo: string;
  /** MOCK credential — in-memory only, never logged or sent to chat. */
  contrasena: string;
  perfil: string;
  fechaInicio: string | null;
  fechaFin: string | null;
  dias: number | null;
  estatus: string;
  nombre: string;
  monto: number | null;
  estado: string;
  numero: string;
  pais: string;
}

interface SheetBinding {
  name: string;
  servicio: MockService;
}

const SHEETS: SheetBinding[] = [
  { name: 'Base FLUJOTV', servicio: 'flujotv' },
  { name: 'Base NETFLIX', servicio: 'netflix' },
];

/** `FECHA QUE ACABA` → `FECHA QUE ACABA` (accents/case/whitespace tolerant). */
function normalizeHeader(header: unknown): string {
  return String(header ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function asText(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return String(value ?? '').trim();
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Excel serial day (1899-12-30 epoch) → `YYYY-MM-DD`; strings pass through. */
export function excelDateToISO(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  const text = asText(value);
  return text === '' ? null : text;
}

/**
 * Loads and normalizes every account from the fixture workbook.
 * Throws when a bound sheet is missing (fail fast, never partial data).
 * The file is opened read-only — it is never written back.
 */
export function loadFixtureAccounts(fixturePath: string): MockAccount[] {
  const workbook = XLSX.readFile(fixturePath);
  const accounts: MockAccount[] = [];

  for (const { name, servicio } of SHEETS) {
    const sheet = workbook.Sheets[name];
    if (sheet === undefined) {
      throw new Error(`Fixture is missing required sheet "${name}" (${fixturePath})`);
    }
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
    for (const row of rows) {
      const byHeader = new Map<string, unknown>();
      for (const [key, value] of Object.entries(row)) {
        if (key.startsWith('__EMPTY')) {
          continue;
        }
        byHeader.set(normalizeHeader(key), value);
      }
      const get = (header: string): unknown => byHeader.get(header) ?? null;
      const nombre = asText(get('NOMBRE'));
      const correo = asText(get('CORREO'));
      const numero = asText(get('NUMERO'));
      if (nombre === '' && correo === '' && numero === '') {
        // Identity-less spreadsheet residue (e.g. DIAS=-46270 formula
        // artifacts on empty formatted rows): unsearchable, not accounts.
        continue;
      }
      accounts.push({
        servicio,
        correo,
        contrasena: asText(get('CONTRASENA')),
        perfil: asText(get('PERFIL')),
        fechaInicio: excelDateToISO(get('FECHA DE INICIO')),
        fechaFin: excelDateToISO(get('FECHA QUE ACABA')),
        dias: asNumber(get('DIAS')),
        estatus: asText(get('ESTATUS')),
        nombre,
        monto: asNumber(get('MONTO')),
        estado: asText(get('ESTADO')),
        numero,
        pais: asText(get('PAIS')),
      });
    }
  }

  return accounts;
}

import { serviceLabel } from './customers';
import type { MockAccount, MockService } from './excelLoader';
import { resolveNetflixPin } from './netflixPin';
import { splitStoredNumbers } from './phone';

/**
 * CredentialBundle domain abstraction (Slice A — SHOW_CREDENTIALS).
 *
 * A bundle is ONE selected assignment's access data, built ONLY from real
 * fixture/model fields — never invented:
 * - Netflix: password belongs to the ACCOUNT (`accountPassword` = the
 *   account-level password shared by the account's rows, `passwordScope:
 *   'account'`), plus the selected `profile` slot label.
 * - FlujoTV: keeps its OWN model (`flujotv-shared` per-slot password from
 *   the assignment's own row, `passwordScope: 'slot'`; `flujotv-complete`
 *   exclusive slot) — the Netflix shape is never forced onto it.
 * - `pin` is present ONLY on Netflix bundles whose assignment phone is
 *   unequivocal (exactly one usable identity across the assignment's own
 *   stored numbers → last-4 rule in `./netflixPin`). Ambiguous assignments
 *   carry no PIN — the caller asks/disambiguates first, never invents.
 *   FlujoTV bundles never carry a PIN.
 *
 * Bundles are built inside the domain/repository layer (see
 * `repositories.ts`) so raw `contrasena` values never flow through the
 * generic search seam — only this explicit path and the central renderer
 * ever touch them.
 */

export type CredentialAccountType = 'netflix-profile' | 'flujotv-shared' | 'flujotv-complete';

export type CredentialPasswordScope = 'account' | 'slot';

export interface CredentialBundle {
  /** Service from the data row itself — never assumed. */
  service: MockService;
  /** Display label (`Netflix`, `FlujoTV`). */
  serviceLabel: string;
  /** CORREO as stored (trimmed): email, username or code. */
  accountIdentifier: string;
  /** Real MOCK credential — explicit-view path only, never logged. */
  accountPassword: string;
  /** Where the password comes from: the account (Netflix) or the slot row (FlujoTV shared). */
  passwordScope: CredentialPasswordScope;
  /** PERFIL as stored (`1 PERFIL (2)`, `1 PERFIL`, `CUENTA COMPLETA`, …). */
  profile: string;
  /** Per-service shape — FlujoTV keeps its own model. */
  accountType: CredentialAccountType;
  /** NOMBRE: the client holding this assignment. */
  customerName: string;
  /** Individual numbers across the assignment's stored NUMERO cell. */
  customerPhones: string[];
  /** PAIS_CUENTA as stored (may be '') — safe display field, never phone-derived. */
  paisCuenta: string;
  /** `FECHA QUE ACABA` of THIS assignment (`YYYY-MM-DD` or null) — never
   *   another assignment's, never legacy DIAS, never invented. */
  fechaFin: string | null;
  /**
   * Derived Netflix profile PIN (last-4 rule in `./netflixPin`) — present
   * ONLY when the assignment's own phone is unequivocal. NEVER on FlujoTV,
   * NEVER invented, NEVER persisted beyond this transient bundle.
   */
  pin?: string;
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Netflix account-level password: the most frequent non-empty
 * `contrasena` across the account's rows (same servicio + normalized
 * identifier). Deterministic; falls back to the row's own value when the
 * account scope carries nothing usable. The password belongs to the
 * ACCOUNT, never to a single profile.
 */
export function accountPasswordFor(accountRows: MockAccount[], row: MockAccount): string {
  const key = `${row.servicio}:${normalizeIdentifier(row.correo)}`;
  const counts = new Map<string, number>();
  for (const candidate of accountRows) {
    if (`${candidate.servicio}:${normalizeIdentifier(candidate.correo)}` !== key) {
      continue;
    }
    const password = candidate.contrasena.trim();
    if (password === '') {
      continue;
    }
    counts.set(password, (counts.get(password) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [password, count] of counts) {
    if (count > bestCount) {
      best = password;
      bestCount = count;
    }
  }
  return best ?? row.contrasena.trim();
}

function accountTypeFor(service: MockService, perfil: string): CredentialAccountType {
  if (service === 'netflix') {
    return 'netflix-profile';
  }
  const compact = perfil
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return compact.includes('completa') ? 'flujotv-complete' : 'flujotv-shared';
}

/**
 * Builds ONE bundle per scoped row (each row = one assignment). `scoped`
 * holds the selected assignments (one customer or one account);
 * `accountScope` holds the rows used to derive account-level passwords
 * (the whole store — Netflix passwords are account facts, not
 * selection-scoped facts).
 */
export function buildCredentialBundles(
  scoped: MockAccount[],
  accountScope: MockAccount[],
): CredentialBundle[] {
  return scoped.map((row) => {
    const type = accountTypeFor(row.servicio, row.perfil);
    const password =
      row.servicio === 'netflix' ? accountPasswordFor(accountScope, row) : row.contrasena.trim();
    const phones = splitStoredNumbers(row.numero);
    const pin =
      row.servicio === 'netflix' ? resolveNetflixPin(phones) : undefined;
    return {
      service: row.servicio,
      serviceLabel: serviceLabel(row.servicio),
      accountIdentifier: row.correo.trim(),
      accountPassword: password,
      passwordScope: row.servicio === 'netflix' ? 'account' : 'slot',
      profile: row.perfil,
      accountType: type,
      customerName: row.nombre.trim(),
      customerPhones: phones,
      paisCuenta: row.pais,
      fechaFin: row.fechaFin,
      ...(pin !== undefined ? { pin } : {}),
    };
  });
}

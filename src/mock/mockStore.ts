import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadFixtureAccounts, type MockAccount } from './excelLoader';
import { normalizePhoneKeys, phonesMatch, splitStoredNumbers } from './phone';

/**
 * MOCK account store: in-memory rows loaded either from the persisted
 * `/data/mock-state.json` snapshot (when it exists) or from the read-only
 * Excel fixture (first boot). Search is a case-insensitive substring
 * match over NOMBRE/CORREO/PERFIL/PAIS/ESTATUS/SERVICIO plus digit match
 * over NUMERO — deterministic, zero Gemini, zero Postgres.
 *
 * Rows hold CORREO/CONTRASEÑA in memory; this module never logs them.
 * Chat-facing projections live in `repositories.ts` (`toSafeAccount`).
 */

export interface MockStoreOpts {
  /** Read-only workbook, e.g. `fixtures/BASE PRUEBA_v2.xlsx`. */
  fixturePath: string;
  /** Persisted snapshot, e.g. `/data/mock-state.json` (EasyPanel volume). */
  statePath: string;
}

interface PersistedMockState {
  accounts: MockAccount[];
}

/** Cap for one deterministic search page (chat formats the top 5). */
export const MAX_SEARCH_RESULTS = 20;

export class MockStore {
  private constructor(readonly accounts: MockAccount[]) {}

  static empty(): MockStore {
    return new MockStore([]);
  }

  /**
   * Creates the store: snapshot file wins when present, otherwise the
   * fixture is loaded and snapshotted best-effort (a failed snapshot
   * never blocks boot — the fixture stays the source of truth).
   */
  static async create(opts: MockStoreOpts): Promise<MockStore> {
    let raw: string | null = null;
    try {
      raw = await fs.readFile(opts.statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (raw !== null) {
      const parsed = JSON.parse(raw) as PersistedMockState;
      return new MockStore(Array.isArray(parsed.accounts) ? parsed.accounts : []);
    }
    const store = new MockStore(loadFixtureAccounts(opts.fixturePath));
    try {
      await store.save(opts.statePath);
    } catch {
      // Best-effort: ephemeral disks boot fine straight from the fixture.
    }
    return store;
  }

  /** Atomic persist: tmp file alongside the target, then rename. */
  async save(statePath: string): Promise<void> {
    const payload: PersistedMockState = { accounts: this.accounts };
    const dir = dirname(statePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = join(dir, `.vokath-mock-${process.pid}-${Date.now()}.tmp`);
    try {
      await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      await fs.rename(tmpPath, statePath);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Deterministic substring search (max MAX_SEARCH_RESULTS, stable order).
   *
   * Phone matching goes through THE one normalizer (`./phone`): both the
   * query and every stored NUMERO cell (multi-number cells split on `/`)
   * become canonical key sets, matched by EXACT key equality only — E.164
   * when libphonenumber-js resolves both sides, country+national when
   * region metadata proves sameness, identical digit strings otherwise —
   * so `4145460657`, `0414-5460657` and `+58 414-5460657` all hit the
   * same row with no hardcoded prefix stripping and no suffix rule.
   * Distinct numbers sharing trailing digits never collide. There is NO
   * digit-substring/contains fallback: a partial tail is not an identity
   * (BR-CUS-007).
   */
  search(query: string): MockAccount[] {
    const q = query.toLowerCase().trim();
    if (q === '') {
      return [];
    }
    const queryKeys = normalizePhoneKeys(q);
    // Whitespace-insensitive service comparison so "Flujo TV", "flujotv"
    // and "FlujoTV" all match the `flujotv` service (same for Netflix).
    const compact = q.replace(/\s+/g, '');
    const matches = this.accounts.filter((account) => {
      if (
        account.nombre.toLowerCase().includes(q) ||
        account.correo.toLowerCase().includes(q) ||
        account.perfil.toLowerCase().includes(q) ||
        account.pais.toLowerCase().includes(q) ||
        account.estatus.toLowerCase().includes(q) ||
        account.servicio.toLowerCase().includes(compact)
      ) {
        return true;
      }
      if (queryKeys.length > 0) {
        const cells = splitStoredNumbers(account.numero);
        if (cells.some((cell) => phonesMatch(queryKeys, normalizePhoneKeys(cell)))) {
          return true;
        }
      }
      return false;
    });
    return matches.slice(0, MAX_SEARCH_RESULTS);
  }

  /**
   * Phone-identity row search: the SAME exact-key matching as `search`
   * but restricted to NUMERO cells (no name/email/service substrings).
   * Backs the read-only phone UX (`searchCustomersByPhone`), which
   * groups these rows into customers in the domain layer.
   */
  searchByPhone(query: string): MockAccount[] {
    const q = query.trim();
    if (q === '') {
      return [];
    }
    const queryKeys = normalizePhoneKeys(q);
    if (queryKeys.length === 0) {
      return [];
    }
    const matches = this.accounts.filter((account) => {
      const cells = splitStoredNumbers(account.numero);
      return cells.some((cell) => phonesMatch(queryKeys, normalizePhoneKeys(cell)));
    });
    return matches.slice(0, MAX_SEARCH_RESULTS);
  }

  /**
   * Neutral account-identifier row search (Slice B): deterministic
   * lookup across BOTH repositories (both sheets live in this one
   * store) WITHOUT asking the service first — the caller reads
   * `servicio` from the matched rows. Matching is exact on the
   * normalized CORREO (`trim().toLowerCase()`), case-insensitive;
   * nothing is ever appended (`cmaxnet001` never becomes
   * `cmaxnet001@gmail.com`) and substrings never bleed (`maxnet001`
   * never matches `cmaxnet001`). Empty queries match nothing and the
   * store is never mutated (unknown identifiers report, never create).
   */
  searchByAccountIdentifier(query: string): MockAccount[] {
    const key = query.trim().toLowerCase();
    if (key === '') {
      return [];
    }
    const matches = this.accounts.filter(
      (account) => account.correo.trim().toLowerCase() === key,
    );
    return matches.slice(0, MAX_SEARCH_RESULTS);
  }

  /** Every row whose ESTATUS is not VIGENTE (POR VENCER, VENCIDO, …). */
  getExpired(): MockAccount[] {
    return this.accounts.filter(
      (account) => account.estatus.trim().toUpperCase() !== 'VIGENTE',
    );
  }

  countByService(): Array<{ servicio: string; total: number }> {
    const totals = new Map<string, number>();
    for (const account of this.accounts) {
      totals.set(account.servicio, (totals.get(account.servicio) ?? 0) + 1);
    }
    return [...totals.entries()].map(([servicio, total]) => ({ servicio, total }));
  }
}

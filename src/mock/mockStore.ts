import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadFixtureAccounts, type MockAccount } from './excelLoader';
import { normalizePhoneKeys, phonesMatch, splitStoredNumbers } from './phone';
import type { PaymentCurrency, PaymentMethod } from '../sale/payments';
import type { CostSnapshot, PriceSnapshot, SaleModality } from '../sale/pricePolicy';
import type { SaleService } from '../sale/newSaleDraft';

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
  sales?: PersistedSaleLedger;
}

/** Persisted form of the NEW_SALE ledger (Slice B — confirm execution). */
interface PersistedSaleLedger {
  operations: SaleLedgerOperation[];
  items: SaleLedgerItem[];
  subscriptions: SaleLedgerSubscription[];
  payments: SaleLedgerPayment[];
  movements: SaleLedgerMovement[];
  audits: SaleLedgerAudit[];
}

/**
 * NEW_SALE operation header (Slice B — atomic confirm). Minimal internal
 * record forming part of the sale: operator, customer, slot, price/cost
 * snapshots (history-immune), payment and dates. NEVER credentials —
 * this type carries no CORREO-adjacent secret field by construction.
 */
export interface SaleLedgerOperation {
  operationId: string;
  idempotencyKey: string;
  type: 'NEW_SALE';
  operator: string;
  chatId: number;
  userId: number;
  customerId: string;
  customerName: string;
  phone: string;
  /**
   * Optional CUSTOMER_LOCATION final value (new-customer proposal or
   * applied existing-customer update). Display/detail only — never
   * PAIS_CUENTA, which lives on the slot rows untouched.
   */
  customerLocation?: import('./customers').CustomerLocation;
  service: SaleService;
  modality: SaleModality;
  monthsRequested: number;
  monthsGranted: number;
  price: PriceSnapshot;
  cost: CostSnapshot;
  payment: {
    actualAmount: number;
    currency: PaymentCurrency;
    method: PaymentMethod;
    receivedBy: string;
    reference?: string;
  };
  serviceAccountId: string;
  slotId: string;
  rowIndex: number;
  startsOn: string;
  expiresOn: string;
  status: 'CONFIRMED';
  confirmedAt: string;
}

export interface SaleLedgerItem {
  id: string;
  operationId: string;
  subscriptionId: string;
  serviceAccountId: string;
  slotId: string;
}

export interface SaleLedgerSubscription {
  id: string;
  operationId: string;
  customerId: string;
  customerName: string;
  phone: string;
  serviceAccountId: string;
  slotId: string;
  perfil: string;
  startsOn: string;
  expiresOn: string;
  months: number;
  price: PriceSnapshot;
  cost: CostSnapshot;
}

export interface SaleLedgerPayment {
  id: string;
  operationId: string;
  amount: number;
  currency: PaymentCurrency;
  method: PaymentMethod;
  receivedBy: string;
  reference?: string;
  paidAt: string;
}

/**
 * Minimal internal cash movement IN (part of the sale — no Caja
 * UI/balances/reports read it; those belong to a later vertical).
 */
export interface SaleLedgerMovement {
  id: string;
  operationId: string;
  direction: 'IN';
  amount: number;
  currency: PaymentCurrency;
  holder: string;
  createdAt: string;
}

/** Secret-free confirm event (no passwords, PINs, or tokens — ever). */
export interface SaleLedgerAudit {
  operationId: string;
  type: 'sale.confirmed';
  operator: string;
  chatId: number;
  userId: number;
  at: string;
  refs: {
    serviceAccountId: string;
    slotId: string;
    modality: SaleModality;
    months: number;
    amount: number;
    currency: PaymentCurrency;
    method: PaymentMethod;
    receivedBy: string;
    customerName: string;
  };
}

export interface SaleLedgerLengths {
  operations: number;
  items: number;
  subscriptions: number;
  payments: number;
  movements: number;
  audits: number;
}

export interface SaleLedgerRecords {
  operation: SaleLedgerOperation;
  item: SaleLedgerItem;
  subscription: SaleLedgerSubscription;
  payment: SaleLedgerPayment;
  movement: SaleLedgerMovement;
  audit: SaleLedgerAudit;
}

/** Cap for one deterministic search page (chat formats the top 5). */
export const MAX_SEARCH_RESULTS = 20;

export class MockStore {
  private constructor(
    readonly accounts: MockAccount[],
    readonly saleOperations: SaleLedgerOperation[] = [],
    readonly saleItems: SaleLedgerItem[] = [],
    readonly saleSubscriptions: SaleLedgerSubscription[] = [],
    readonly salePayments: SaleLedgerPayment[] = [],
    readonly saleMovements: SaleLedgerMovement[] = [],
    readonly saleAudits: SaleLedgerAudit[] = [],
  ) {}

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
      const sales = parsed.sales;
      return new MockStore(
        Array.isArray(parsed.accounts) ? parsed.accounts : [],
        Array.isArray(sales?.operations) ? sales.operations : [],
        Array.isArray(sales?.items) ? sales.items : [],
        Array.isArray(sales?.subscriptions) ? sales.subscriptions : [],
        Array.isArray(sales?.payments) ? sales.payments : [],
        Array.isArray(sales?.movements) ? sales.movements : [],
        Array.isArray(sales?.audits) ? sales.audits : [],
      );
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
    const payload: PersistedMockState = {
      accounts: this.accounts,
      sales: {
        operations: this.saleOperations,
        items: this.saleItems,
        subscriptions: this.saleSubscriptions,
        payments: this.salePayments,
        movements: this.saleMovements,
        audits: this.saleAudits,
      },
    };
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

  // -------------------------------------------------------------------------
  // NEW_SALE atomic seam (Slice B — Postgres-swappable).
  //
  // The confirm service mutates through THESE methods only: slot assignment
  // (prev-copy out for rollback) + one ledger push + length-based truncate.
  // Idempotency reads `findSaleOperation(operationId)` BEFORE mutating, so
  // a repeat confirm returns the stored header with zero new rows.
  // -------------------------------------------------------------------------

  /** Idempotency lookup: the stored header for an operation id, if any. */
  findSaleOperation(operationId: string): SaleLedgerOperation | undefined {
    return this.saleOperations.find((operation) => operation.operationId === operationId);
  }

  /**
   * Assigns a free slot row to the confirmed customer: NOMBRE + NUMERO +
   * FECHA DE INICIO/FIN only (+ UBICACION display when the sale carries
   * one — new-customer location persists ONLY here, at confirm).
   * Legacy DIAS/ESTATUS columns are never read or written here. Returns
   * the prev row copy for rollback.
   */
  assignSaleSlot(
    rowIndex: number,
    patch: {
      nombre: string;
      numero: string;
      fechaInicio: string;
      fechaFin: string;
      ubicacion?: string | null;
    },
  ): MockAccount {
    const row = this.accounts[rowIndex];
    if (row === undefined) {
      throw new Error(`assignSaleSlot: unknown row ${rowIndex}`);
    }
    const prev: MockAccount = { ...row };
    row.nombre = patch.nombre;
    row.numero = patch.numero;
    row.fechaInicio = patch.fechaInicio;
    row.fechaFin = patch.fechaFin;
    if (patch.ubicacion !== undefined) {
      if (patch.ubicacion === null || patch.ubicacion.trim() === '') {
        delete row.ubicacion;
      } else {
        row.ubicacion = patch.ubicacion;
      }
    }
    return prev;
  }

  /**
   * Applies a confirmed existing-customer location update to EVERY row
   * owned by that customer (normalized-name match — the MOCK grouping
   * key). Returns prev copies for rollback. Cancel/no-inventory never
   * call this (the draft update dies with the draft).
   */
  updateCustomerUbicacion(
    customerId: string,
    display: string,
  ): Array<{ rowIndex: number; prev: MockAccount }> {
    const touched: Array<{ rowIndex: number; prev: MockAccount }> = [];
    this.accounts.forEach((row, rowIndex) => {
      if (row.nombre.trim().toLowerCase() === customerId) {
        touched.push({ rowIndex, prev: { ...row } });
        row.ubicacion = display;
      }
    });
    return touched;
  }

  /** Rollback: restores one slot row from its prev copy. */
  restoreSaleSlot(rowIndex: number, prev: MockAccount): void {
    this.accounts[rowIndex] = { ...prev };
  }

  /** Current ledger lengths (rollback cursor for `truncateSaleLedger`). */
  saleLedgerLengths(): SaleLedgerLengths {
    return {
      operations: this.saleOperations.length,
      items: this.saleItems.length,
      subscriptions: this.saleSubscriptions.length,
      payments: this.salePayments.length,
      movements: this.saleMovements.length,
      audits: this.saleAudits.length,
    };
  }

  /** Pushes one full sale unit (operation + item + subscription + payment + movement + audit). */
  pushSaleRecords(records: SaleLedgerRecords): void {
    this.saleOperations.push(records.operation);
    this.saleItems.push(records.item);
    this.saleSubscriptions.push(records.subscription);
    this.salePayments.push(records.payment);
    this.saleMovements.push(records.movement);
    this.saleAudits.push(records.audit);
  }

  /** Rollback: drops every ledger row pushed after the cursor. */
  truncateSaleLedger(lengths: SaleLedgerLengths): void {
    this.saleOperations.length = lengths.operations;
    this.saleItems.length = lengths.items;
    this.saleSubscriptions.length = lengths.subscriptions;
    this.salePayments.length = lengths.payments;
    this.saleMovements.length = lengths.movements;
    this.saleAudits.length = lengths.audits;
  }
}

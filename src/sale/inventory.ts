/**
 * NewSale inventory selection — PROPOSAL ONLY (Slice A).
 *
 * Availability rule (BR-INV-001, BR-SLOT-005): a slot is assignable iff
 * its account is operationally ACTIVE, its slot row is free, and no
 * active assignment holds it. Vencimiento never frees: an
 * assigned-even-expired row stays occupied (its `nombre` is non-empty).
 *
 * MOCK grounding — every predicate reads real row fields, nothing else:
 * - Occupied = `nombre.trim() !== ''` (holding client present).
 * - Free = `nombre` empty/blank on a row with a real account identifier.
 *   (Fixture proof: `hfghfgbghfghg@hotmail.com` carries two free
 *   `1 PERFIL (4)` rows; every FlujoTV row is occupied.)
 * - Rows are slots (see `mock/accounts.ts`): capacity defaults to the
 *   observed slot-row count of the account; explicit per-account
 *   overrides only narrow it.
 * - The fixture carries NO account-status column, so operational status
 *   comes from an injected resolver defaulting every account to ACTIVE;
 *   tests pin FALLEN / WAITING_SUPPLIER / BLOCKED through overrides.
 *   Legacy ESTATUS/DIAS never govern availability.
 *
 * Priority (BR-NFX-003): partially-occupied ACTIVE commercial →
 * fully-free ACTIVE → emergency profile-5 ONLY when no commercial is
 * free anywhere (BR-NFX-004), and emergency is NEVER auto-used: it
 * returns `emergency-auth-required` with an explicit ⚠️ card +
 * [Usar emergencia][Cancelar], separate from sale confirmation
 * (BR-NFX-005). Revalidation at confirm is DESIGNED here
 * (`revalidateProposal`) and EXECUTED in Slice B (BR-SAL-007,
 * BR-OPS-005).
 */

import type { MockAccount } from '../mock/excelLoader';
import type { SaleModality } from './pricePolicy';

export type AccountOperationalStatus = 'ACTIVE' | 'FALLEN' | 'WAITING_SUPPLIER' | 'BLOCKED';

export type AccountStatusResolver = (serviceAccountId: string) => AccountOperationalStatus;

/** MOCK default: no status column exists, every account reads ACTIVE. */
export const defaultAccountStatus: AccountStatusResolver = () => 'ACTIVE';

/** Evidence marker: proposals address row positions of one store snapshot. */
export const MOCK_INVENTORY_VERSION = 'mock-rows-v1';

export function serviceAccountIdForRow(row: MockAccount): string {
  return `${row.servicio}:${row.correo.trim().toLowerCase()}`;
}

/** True when a holding client occupies the slot (assigned, even if expired). */
export function isRowOccupied(row: MockAccount): boolean {
  return row.nombre.trim() !== '';
}

export type NetflixSlotKind = 'commercial' | 'emergency' | 'unknown';

/**
 * Netflix profile class (BR-NFX-001/002): parenthesized number 1–4 =
 * commercial, 5 = emergency. `PERFIL (EXTRA)` / blank / unparsable =
 * unknown → never assignable (fail closed, never guessed).
 */
export function classifyNetflixProfile(perfil: string): NetflixSlotKind {
  const match = /\(\s*(\d+)\s*\)/.exec(perfil);
  if (match?.[1] === undefined) {
    return 'unknown';
  }
  const slot = Number(match[1]);
  if (slot >= 1 && slot <= 4) {
    return 'commercial';
  }
  if (slot === 5) {
    return 'emergency';
  }
  return 'unknown';
}

export type FlujoSlotKind = 'shared' | 'complete' | 'unknown';

/**
 * FlujoTV keeps its OWN model (never the Netflix 5-profile shape):
 * `CUENTA COMPLETA` = exclusive slot, `1 PERFIL` = shared slot,
 * anything else = unknown → never assignable.
 */
export function classifyFlujoSlot(perfil: string): FlujoSlotKind {
  const n = perfil
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (n.includes('completa') || n.includes('exclusiva')) {
    return 'complete';
  }
  if (n.includes('perfil')) {
    return 'shared';
  }
  return 'unknown';
}

export interface InventoryCandidate {
  /** Stable within one store snapshot: `row:<index>`. */
  slotId: string;
  rowIndex: number;
  serviceAccountId: string;
  /** PERFIL as stored. */
  perfil: string;
  kind: NetflixSlotKind | FlujoSlotKind;
}

export interface InventoryEvidence {
  inventoryVersion: typeof MOCK_INVENTORY_VERSION;
  serviceAccountId: string;
  slotId: string;
  rowIndex: number;
  perfil: string;
  observedAt: string;
}

export type InventoryProposal =
  | { kind: 'slot'; candidate: InventoryCandidate; evidence: InventoryEvidence }
  | { kind: 'emergency-auth-required'; candidate: InventoryCandidate; evidence: InventoryEvidence }
  | { kind: 'none'; reason: 'no-commercial-or-emergency' | 'no-shared-capacity' | 'no-complete-free' };

export interface SelectInventoryOpts {
  statusOf?: AccountStatusResolver;
  /** Per-account slot capacity (FlujoTV shared); defaults to observed rows. */
  capacityOverrides?: Record<string, number>;
}

interface AccountGroup {
  id: string;
  indexes: number[];
}

function groupActiveAccounts(rows: MockAccount[], opts: SelectInventoryOpts): AccountGroup[] {
  const statusOf = opts.statusOf ?? defaultAccountStatus;
  const groups = new Map<string, number[]>();
  const order: string[] = [];
  rows.forEach((row, index) => {
    const id = serviceAccountIdForRow(row);
    if (row.correo.trim() === '') {
      return;
    }
    if (statusOf(id) !== 'ACTIVE') {
      return;
    }
    const existing = groups.get(id);
    if (existing === undefined) {
      groups.set(id, [index]);
      order.push(id);
    } else {
      existing.push(index);
    }
  });
  return order.map((id) => ({ id, indexes: groups.get(id) ?? [] }));
}

function candidateFor(rows: MockAccount[], rowIndex: number, kind: InventoryCandidate['kind']): InventoryCandidate {
  const row = rows[rowIndex] as MockAccount;
  return {
    slotId: `row:${rowIndex}`,
    rowIndex,
    serviceAccountId: serviceAccountIdForRow(row),
    perfil: row.perfil,
    kind,
  };
}

function evidenceFor(candidate: InventoryCandidate, now: string = new Date().toISOString()): InventoryEvidence {
  return {
    inventoryVersion: MOCK_INVENTORY_VERSION,
    serviceAccountId: candidate.serviceAccountId,
    slotId: candidate.slotId,
    rowIndex: candidate.rowIndex,
    perfil: candidate.perfil,
    observedAt: now,
  };
}

function selectNetflix(rows: MockAccount[], groups: AccountGroup[]): InventoryProposal {
  const partial: InventoryCandidate[] = [];
  const fresh: InventoryCandidate[] = [];
  const emergency: InventoryCandidate[] = [];
  for (const group of groups) {
    if (group.id.startsWith('flujotv:')) {
      continue;
    }
    let occupied = 0;
    const freeCommercial: InventoryCandidate[] = [];
    for (const index of group.indexes) {
      const row = rows[index] as MockAccount;
      if (isRowOccupied(row)) {
        occupied += 1;
        continue;
      }
      const kind = classifyNetflixProfile(row.perfil);
      if (kind === 'commercial') {
        freeCommercial.push(candidateFor(rows, index, kind));
      } else if (kind === 'emergency') {
        emergency.push(candidateFor(rows, index, kind));
      }
    }
    if (freeCommercial.length === 0) {
      continue;
    }
    if (occupied > 0) {
      partial.push(...freeCommercial);
    } else {
      fresh.push(...freeCommercial);
    }
  }
  const commercial = partial.length > 0 ? partial : fresh;
  const best = commercial[0];
  if (best !== undefined) {
    return { kind: 'slot', candidate: best, evidence: evidenceFor(best) };
  }
  const fallback = emergency[0];
  if (fallback !== undefined) {
    return { kind: 'emergency-auth-required', candidate: fallback, evidence: evidenceFor(fallback) };
  }
  return { kind: 'none', reason: 'no-commercial-or-emergency' };
}

function selectFlujoShared(
  rows: MockAccount[],
  groups: AccountGroup[],
  opts: SelectInventoryOpts,
): InventoryProposal {
  for (const group of groups) {
    if (!group.id.startsWith('flujotv:')) {
      continue;
    }
    const shared = group.indexes.filter(
      (index) => classifyFlujoSlot((rows[index] as MockAccount).perfil) === 'shared',
    );
    if (shared.length === 0) {
      continue;
    }
    const capacity = opts.capacityOverrides?.[group.id] ?? shared.length;
    const occupied = shared.filter((index) => isRowOccupied(rows[index] as MockAccount)).length;
    if (occupied >= capacity) {
      continue;
    }
    const free = shared.find((index) => !isRowOccupied(rows[index] as MockAccount));
    if (free === undefined) {
      continue;
    }
    const candidate = candidateFor(rows, free, 'shared');
    return { kind: 'slot', candidate, evidence: evidenceFor(candidate) };
  }
  return { kind: 'none', reason: 'no-shared-capacity' };
}

function selectFlujoComplete(rows: MockAccount[], groups: AccountGroup[]): InventoryProposal {
  for (const group of groups) {
    if (!group.id.startsWith('flujotv:')) {
      continue;
    }
    const complete = group.indexes.filter(
      (index) => classifyFlujoSlot((rows[index] as MockAccount).perfil) === 'complete',
    );
    if (complete.length === 0) {
      continue;
    }
    // Exclusivity (BR-SLOT-004): ANY occupied row blocks the account —
    // assigned-even-expired stays unavailable (BR-SLOT-005).
    const occupied = group.indexes.some((index) => isRowOccupied(rows[index] as MockAccount));
    if (occupied) {
      continue;
    }
    const free = complete.find((index) => !isRowOccupied(rows[index] as MockAccount));
    if (free === undefined) {
      continue;
    }
    const candidate = candidateFor(rows, free, 'complete');
    return { kind: 'slot', candidate, evidence: evidenceFor(candidate) };
  }
  return { kind: 'none', reason: 'no-complete-free' };
}

/**
 * Priority proposal for one modality. Pure + deterministic (first-seen
 * account order, row order inside accounts) — proposal only, zero
 * mutation, zero reservation (BR-OPS-005).
 */
export function selectInventory(
  rows: MockAccount[],
  modality: SaleModality,
  opts: SelectInventoryOpts = {},
): InventoryProposal {
  const groups = groupActiveAccounts(rows, opts);
  switch (modality) {
    case 'netflix-profile':
      return selectNetflix(rows, groups);
    case 'flujotv-shared':
      return selectFlujoShared(rows, groups, opts);
    case 'flujotv-complete':
      return selectFlujoComplete(rows, groups);
  }
}

export interface Revalidation {
  ok: boolean;
  reason?: 'slot-taken' | 'account-inactive' | 'slot-unknown';
}

/**
 * Revalidate-at-confirm design (Slice B executes): the exact evidenced
 * slot must still exist, still be free, still classify the same, and
 * its account must still be ACTIVE. Any drift fails closed
 * (BR-SAL-007) so the draft recalculates instead of executing.
 */
export function revalidateProposal(
  rows: MockAccount[],
  evidence: InventoryEvidence,
  opts: SelectInventoryOpts = {},
): Revalidation {
  const statusOf = opts.statusOf ?? defaultAccountStatus;
  const row = rows[evidence.rowIndex];
  if (row === undefined || serviceAccountIdForRow(row) !== evidence.serviceAccountId) {
    return { ok: false, reason: 'slot-unknown' };
  }
  if (statusOf(evidence.serviceAccountId) !== 'ACTIVE') {
    return { ok: false, reason: 'account-inactive' };
  }
  if (isRowOccupied(row) || row.perfil !== evidence.perfil) {
    return { ok: false, reason: 'slot-taken' };
  }
  return { ok: true };
}

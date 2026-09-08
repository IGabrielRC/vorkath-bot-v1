/**
 * NewSaleDraft entity + per-operator store (Slice A — draft & proposal).
 *
 * This is NOT the generic demo draft (`drafts/engine.ts`, months-only):
 * it is the NEW_SALE operation draft (BR-SAL-001) carrying service,
 * modality, customer, duration, inventory proposal, price/cost snapshots
 * and payment. Slice A builds and corrects the draft; confirmation
 * EXECUTION belongs to Slice B — `confirm()` here refuses explicitly and
 * performs zero side-effects.
 *
 * Invariants:
 * - NO credentials/password/PIN ever enter the draft payload
 *   (BR-AUD-005; summary renderer asserts the same).
 * - NO expiry: drafts persist until explicit CONFIRM or CANCEL
 *   (BR-OPS-001/002). No TTL field exists anywhere in this module.
 * - One critical draft per operator: creating while one is open
 *   RECOVERS it, never silently replaces it (existing engine policy).
 * - New customers live as `proposedCustomer` inside the draft; NOTHING
 *   persists before confirm — cancel/no-inventory leaves nothing
 *   (BR-SAL-009/010). The store holds drafts only; there is no customer
 *   write path in this module at all.
 * - Service/modality switch INVALIDATES the proposal + snapshots
 *   (recalculate, never reuse a stale slot/price).
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CustomerLocation } from '../mock/customers';
import type { PaymentCurrency, PaymentMethod } from './payments';
import type { CostSnapshot, PriceSnapshot, SaleModality } from './pricePolicy';
import type { InventoryEvidence, InventoryProposal } from './inventory';

export type NewSaleStatus = 'DRAFT' | 'CONFIRMED' | 'CANCELLED';

export interface DraftOwner {
  chatId: number;
  userId: number;
  name?: string;
}

/** New customer collected INSIDE the sale only (BR-CUS-009). */
export interface ProposedCustomer {
  name: string;
  phone: string;
  /**
   * Optional CUSTOMER_LOCATION (capture-if-provided, never asked):
   * lives in the draft, persists ONLY on confirm. Never PAIS_CUENTA.
   */
  location?: CustomerLocation;
}

/**
 * Existing-customer location update proposed INSIDE the sale (no
 * separate operation): explicit in-sale location for a known customer
 * is shown compactly in the summary (`📍 Ubicación: Caracas →
 * Valencia`), applied on confirm, kept (untouched) on cancel.
 */
export interface LocationUpdate {
  existingCustomerId: string;
  /** Stored location before the sale (`null` when the customer has none). */
  from: CustomerLocation | null;
  /** Explicit in-sale location (never inherited across operations). */
  to: CustomerLocation;
}

export interface NewSaleCustomer {
  existingCustomerId?: string;
  proposedCustomer?: ProposedCustomer;
  /**
   * In-sale location update for the linked existing customer (set ONLY
   * from an explicit current-turn location; never inherited, never
   * asked). Cleared with the customer linkage on phone re-resolution.
   */
  locationUpdate?: LocationUpdate;
  /**
   * Location captured while the phone is known but the customer is not
   * yet resolved (unknown/shared phone): held in the draft, folded into
   * `proposedCustomer` when the name arrives or converted to
   * `locationUpdate` on explicit customer selection. Never asked, never
   * blocking, dropped on cancel with everything else.
   */
  pendingLocation?: CustomerLocation;
}

export type SaleService = 'netflix' | 'flujotv';

export interface SaleDuration {
  /** Null until the operator states months (ask-only-missing, BR-SAL-003). */
  requestedMonths: number | null;
  grantedMonths: number | null;
}

export interface ProposedAssignment {
  serviceAccountId: string;
  slotId: string;
  evidence: InventoryEvidence;
  /** Emergency slots travel unauthorized until an explicit auth action. */
  emergencyRequired: boolean;
  emergencyAuthorized: boolean;
}

export interface SalePayment {
  actualAmount: number | null;
  currency: PaymentCurrency | null;
  method: PaymentMethod | null;
  /** Explicit holder only — never defaulted from the operator. */
  receivedBy: string | null;
  reference?: string;
}

export interface NewSaleDraft {
  operationId: string;
  kind: 'NEW_SALE';
  owner: DraftOwner;
  customer: NewSaleCustomer;
  /** Operational phone as given (raw); identity matching stays in phone.ts. */
  phone: string | null;
  service: SaleService | null;
  modality: SaleModality | null;
  duration: SaleDuration;
  proposal: ProposedAssignment | null;
  /** `emergency-auth-required` proposals wait for explicit auth (Slice B UI). */
  proposalAwaitingEmergencyAuth: boolean;
  price: PriceSnapshot | null;
  cost: CostSnapshot | null;
  payment: SalePayment;
  /** Operator display name derived from the session — never asked. */
  operator: string;
  status: NewSaleStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Slice A confirm refusal: the button/path may exist, execution must not. */
export const SALE_CONFIRM_REFUSED_TEXT =
  '⏳ La confirmación de ventas se habilita en el siguiente paso (Slice B). El borrador sigue abierto.';

function now(): string {
  return new Date().toISOString();
}

export function newOperationId(): string {
  return `ns-${randomBytes(4).toString('hex')}`;
}

function keyOf(owner: DraftOwner): string {
  return `${owner.chatId}:${owner.userId}`;
}

export function createNewSaleDraft(owner: DraftOwner, operator: string): NewSaleDraft {
  const stamp = now();
  return {
    operationId: newOperationId(),
    kind: 'NEW_SALE',
    owner: { ...owner },
    customer: {},
    phone: null,
    service: null,
    modality: null,
    duration: { requestedMonths: null, grantedMonths: null },
    proposal: null,
    proposalAwaitingEmergencyAuth: false,
    price: null,
    cost: null,
    payment: { actualAmount: null, currency: null, method: null, receivedBy: null },
    operator,
    status: 'DRAFT',
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export interface SalePatch {
  service?: SaleService | null;
  modality?: SaleModality | null;
  requestedMonths?: number;
  phone?: string | null;
  existingCustomerId?: string | null;
  proposedCustomer?: ProposedCustomer | null;
  locationUpdate?: LocationUpdate | null;
  pendingLocation?: CustomerLocation | null;
  actualAmount?: number | null;
  currency?: PaymentCurrency | null;
  method?: PaymentMethod | null;
  receivedBy?: string | null;
  reference?: string | null;
}

export interface PatchOutcome {
  draft: NewSaleDraft;
  /** True when service/modality changed → proposal + snapshots cleared. */
  proposalInvalidated: boolean;
}

/**
 * Conversational correction (BR-OPS-006): patches the SAME draft,
 * bumps version, clears the proposal + price/cost snapshots when the
 * service or modality changed. Snapshot recomputation + inventory
 * reselection run in the tool layer after this pure patch.
 */
export function applySalePatch(draft: NewSaleDraft, patch: SalePatch): PatchOutcome {
  const serviceChanged = patch.service !== undefined && patch.service !== draft.service;
  const modalityChanged = patch.modality !== undefined && patch.modality !== draft.modality;
  const proposalInvalidated = serviceChanged || modalityChanged;
  const customer: NewSaleCustomer = {};
  if (patch.existingCustomerId !== undefined) {
    if (patch.existingCustomerId !== null) {
      customer.existingCustomerId = patch.existingCustomerId;
    }
  } else if (draft.customer.existingCustomerId !== undefined) {
    customer.existingCustomerId = draft.customer.existingCustomerId;
  }
  if (patch.proposedCustomer !== undefined) {
    if (patch.proposedCustomer !== null) {
      customer.proposedCustomer = patch.proposedCustomer;
    }
  } else if (draft.customer.proposedCustomer !== undefined) {
    customer.proposedCustomer = draft.customer.proposedCustomer;
  }
  // Location state travels with the linkage: re-resolving the phone
  // (existingCustomerId/proposedCustomer explicitly reset) drops stale
  // updates — a new linkage never inherits a previous location.
  // Untouched linkages keep their location state across unrelated
  // patches (amount, receiver, …).
  const linkageReset =
    patch.existingCustomerId !== undefined || patch.proposedCustomer !== undefined;
  if (patch.locationUpdate !== undefined) {
    if (patch.locationUpdate !== null) {
      customer.locationUpdate = patch.locationUpdate;
    }
  } else if (!linkageReset && draft.customer.locationUpdate !== undefined) {
    customer.locationUpdate = draft.customer.locationUpdate;
  }
  if (patch.pendingLocation !== undefined) {
    if (patch.pendingLocation !== null) {
      customer.pendingLocation = patch.pendingLocation;
    }
  } else if (!linkageReset && draft.customer.pendingLocation !== undefined) {
    customer.pendingLocation = draft.customer.pendingLocation;
  }
  const next: NewSaleDraft = {
    ...draft,
    ...(patch.service !== undefined ? { service: patch.service } : {}),
    ...(patch.modality !== undefined ? { modality: patch.modality } : {}),
    ...(patch.requestedMonths !== undefined
      ? {
          duration: { requestedMonths: patch.requestedMonths, grantedMonths: patch.requestedMonths },
        }
      : {}),
    ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
    customer,
    payment: {
      actualAmount: patch.actualAmount !== undefined ? patch.actualAmount : draft.payment.actualAmount,
      currency: patch.currency !== undefined ? patch.currency : draft.payment.currency,
      method: patch.method !== undefined ? patch.method : draft.payment.method,
      receivedBy: patch.receivedBy !== undefined ? patch.receivedBy : draft.payment.receivedBy,
      ...(patch.reference !== undefined
        ? patch.reference === null
          ? {}
          : { reference: patch.reference }
        : draft.payment.reference !== undefined
          ? { reference: draft.payment.reference }
          : {}),
    },
    ...(proposalInvalidated
      ? {
          proposal: null,
          proposalAwaitingEmergencyAuth: false,
          price: null,
          cost: null,
        }
      : {}),
    version: draft.version + 1,
    updatedAt: now(),
  };
  return { draft: next, proposalInvalidated };
}

/** Attaches a fresh inventory proposal (+ snapshots set by the caller). */
export function attachProposal(
  draft: NewSaleDraft,
  proposal: InventoryProposal,
  snapshots: { price: PriceSnapshot; cost: CostSnapshot } | null,
): NewSaleDraft {
  if (proposal.kind === 'none') {
    return {
      ...draft,
      proposal: null,
      proposalAwaitingEmergencyAuth: false,
      price: null,
      cost: null,
      version: draft.version + 1,
      updatedAt: now(),
    };
  }
  const emergencyRequired = proposal.kind === 'emergency-auth-required';
  return {
    ...draft,
    proposal: {
      serviceAccountId: proposal.candidate.serviceAccountId,
      slotId: proposal.candidate.slotId,
      evidence: proposal.evidence,
      emergencyRequired,
      emergencyAuthorized: false,
    },
    proposalAwaitingEmergencyAuth: emergencyRequired,
    ...(snapshots === null ? { price: null, cost: null } : { price: snapshots.price, cost: snapshots.cost }),
    version: draft.version + 1,
    updatedAt: now(),
  };
}

/** Explicit emergency authorization (separate from sale confirmation). */
export function authorizeEmergency(draft: NewSaleDraft): NewSaleDraft | undefined {
  if (draft.proposal === null || !draft.proposal.emergencyRequired) {
    return undefined;
  }
  return {
    ...draft,
    proposal: { ...draft.proposal, emergencyAuthorized: true },
    proposalAwaitingEmergencyAuth: false,
    version: draft.version + 1,
    updatedAt: now(),
  };
}

export interface SaleConfirmRefusal {
  ok: false;
  text: string;
}

/**
 * One open NEW_SALE draft per operator. `create` recovers the open
 * draft (never silently replaces); drafts never expire; `cancel`
 * REMOVES the draft so nothing persists (BR-SAL-010); `confirm`
 * REFUSES in Slice A (Slice B executes atomically).
 */
export class NewSaleDraftStore {
  private readonly drafts = new Map<string, NewSaleDraft>();

  create(owner: DraftOwner, operator: string): { draft: NewSaleDraft; resumed: boolean } {
    const key = keyOf(owner);
    const existing = this.drafts.get(key);
    if (existing !== undefined && existing.status === 'DRAFT') {
      return { draft: existing, resumed: true };
    }
    const draft = createNewSaleDraft(owner, operator);
    this.drafts.set(key, draft);
    return { draft, resumed: false };
  }

  get(owner: DraftOwner): NewSaleDraft | undefined {
    const found = this.drafts.get(keyOf(owner));
    return found !== undefined && found.status === 'DRAFT' ? found : undefined;
  }

  save(draft: NewSaleDraft): void {
    if (draft.status !== 'DRAFT') {
      return;
    }
    this.drafts.set(keyOf(draft.owner), draft);
  }

  /** Explicit cancel: the draft is dropped — no customer, no reservation. */
  cancel(owner: DraftOwner): boolean {
    return this.drafts.delete(keyOf(owner));
  }

  /**
   * Slice B: marks the open draft CONFIRMED (kept for repeat-confirm
   * lookup — `get` still serves DRAFT-only, `confirmed` serves the
   * confirmed header). Ledger idempotency lives in MockStore; this flag
   * only answers "already confirmed" without re-executing.
   */
  confirmSale(owner: DraftOwner): NewSaleDraft | undefined {
    const key = keyOf(owner);
    const current = this.drafts.get(key);
    if (current === undefined || current.status !== 'DRAFT') {
      return undefined;
    }
    const confirmed: NewSaleDraft = {
      ...current,
      status: 'CONFIRMED',
      updatedAt: now(),
    };
    this.drafts.set(key, confirmed);
    return confirmed;
  }

  /** The CONFIRMED header for this owner, if the draft already executed. */
  confirmed(owner: DraftOwner): NewSaleDraft | undefined {
    const found = this.drafts.get(keyOf(owner));
    return found !== undefined && found.status === 'CONFIRMED' ? found : undefined;
  }

  /** Slice A: confirm exists as a path but never executes (Slice B). */
  confirm(_owner: DraftOwner): SaleConfirmRefusal {
    return { ok: false, text: SALE_CONFIRM_REFUSED_TEXT };
  }

  snapshot(): NewSaleDraft[] {
    return [...this.drafts.values()];
  }

  restore(drafts: NewSaleDraft[]): void {
    this.drafts.clear();
    for (const draft of drafts) {
      if (draft.kind === 'NEW_SALE' && draft.status === 'DRAFT') {
        this.drafts.set(keyOf(draft.owner), { ...draft });
      }
    }
  }

  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * Atomic persist (tmp + rename, same-device tmp so rename() never
   * hits EXDEV — same pattern as DraftEngine/InteractionStore).
   * The queue self-heals: a failed write rejects only its own caller
   * and never poisons later saves, so sale drafts are never silently
   * lost after one bad write. Called best-effort by the webhook after
   * every mutation and once at boot — real sale drafts survive
   * EasyPanel redeploys.
   */
  saveToFile(filePath: string): Promise<void> {
    const run = async (): Promise<void> => {
      const dir = dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      const tmpPath = join(dir, `.vokath-sale-drafts-${process.pid}-${Date.now()}.tmp`);
      try {
        await fs.writeFile(tmpPath, JSON.stringify(this.snapshot(), null, 2), 'utf8');
        await fs.rename(tmpPath, filePath);
      } catch (error) {
        await fs.unlink(tmpPath).catch(() => undefined);
        throw error;
      }
    };
    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }

  /** Best-effort load: missing file means first boot — start empty. */
  async loadFromFile(filePath: string): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return;
    }
    const valid = (parsed as NewSaleDraft[]).filter(
      (draft) =>
        typeof draft?.operationId === 'string' &&
        draft.kind === 'NEW_SALE' &&
        typeof draft?.owner?.chatId === 'number' &&
        typeof draft?.owner?.userId === 'number' &&
        (draft.status === 'DRAFT' || draft.status === 'CONFIRMED' || draft.status === 'CANCELLED'),
    );
    this.restore(valid);
  }
}

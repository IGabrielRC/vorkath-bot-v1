/**
 * `confirmNewSale` — the ONE execution entry for NewSale confirmation
 * (Slice B — atomic MOCK sale).
 *
 * Lives in domain/service + the MockStore seam (Postgres-swappable
 * later), NEVER in Telegram handlers: handlers route, this service
 * executes. All-or-nothing, in-memory, with full rollback:
 *
 *  1. draft/version revalidation (stale version → version-conflict,
 *     nothing mutates);
 *  2. emergency gate (unauthorized emergency → emergency-auth, the
 *     explicit auth action stays separate from sale confirmation);
 *  3. price-version revalidation (stale policy → recalc draft + fresh
 *     summary + re-confirm, never partial);
 *  4. inventory revalidation via `revalidateProposal` (drift → recalc +
 *     fresh summary + re-confirm; nothing free → Sin inventario state);
 *  5. atomic commit: Customer/Phone ONLY when proposed-new (slot-row
 *     assignment — the MOCK customer write), NEW_SALE operation +
 *     operation_item + subscription (starts_on/expires_on from the
 *     injected Clock, no legacy DIAS, no invented promos) + slot
 *     assignment + payment + cash movement IN (minimal internal MOCK
 *     records, part of the sale — no Caja UI/balances/reports) +
 *     audit/event + price/cost snapshots → CONFIRMED.
 *
 * Any failure → full rollback (no orphan customer/slot/payment/sale):
 * the slot row is restored from its prev copy and every ledger row
 * pushed after the cursor is truncated.
 *
 * Idempotency: the draft `operationId` is the idempotency key. A repeat
 * confirm (double Confirm tap, repeat callback) finds the stored
 * operation header and answers `already confirmed` with zero new rows:
 * exactly 1 sale/subscription/assignment/payment/movement.
 *
 * Concurrency: single-threaded execution makes check-then-mutate
 * atomic inside one call — Gabriel+Edward racing the same slot resolve
 * sequentially (first wins, second revalidates to another slot or Sin
 * inventario, never double-assigns). A Postgres port must enforce the
 * same with a unique partial index on the slot assignment.
 *
 * Security: this module never reads CORREO/CONTRASEÑA, never builds a
 * credential bundle pre-confirm, never logs secrets. Audit/alert
 * payloads carry safe refs only (operationId, service, modality,
 * amounts, account refs) — no passwords, no PINs, no tokens.
 */

import { buildCredentialBundles, type CredentialBundle } from '../mock/credentials';
import { groupRowsIntoCustomers } from '../mock/customers';
import type { MockAccount } from '../mock/excelLoader';
import type {
  MockStore,
  SaleLedgerAudit,
  SaleLedgerMovement,
  SaleLedgerOperation,
  SaleLedgerPayment,
} from '../mock/mockStore';
import { renderCredentialCard, renderSaleConfirmed } from '../telegram/render';
import {
  buildWhatsAppUrl,
  resolveWhatsAppTarget,
  WHATSAPP_NO_NUMBER_TEXT,
} from '../whatsapp/link';
import { renderCredentialWhatsAppText } from '../whatsapp/templates';
import {
  revalidateProposal,
  selectInventory,
  type AccountStatusResolver,
} from './inventory';
import {
  SALE_CONFIRM_REFUSED_TEXT,
  attachProposal,
  type DraftOwner,
  type NewSaleDraft,
  type NewSaleDraftStore,
  type SaleService,
} from './newSaleDraft';
import type { PaymentCurrency, PaymentMethod } from './payments';
import {
  COST_POLICY_ID,
  COST_POLICY_VERSION,
  COST_TABLE_V1,
  PRICE_POLICY_ID,
  PRICE_POLICY_VERSION,
  PRICE_TABLE_V1,
  costSnapshotFor,
  priceSnapshotFor,
  type CostTable,
  type PriceTable,
  type SaleModality,
} from './pricePolicy';

/** Injectable clock — tests pin the date, production uses the system. */
export interface SaleClock {
  now(): Date;
}

export const systemSaleClock: SaleClock = { now: () => new Date() };

/** Test-only fault injection: throws mid-commit to prove rollback. */
export type ConfirmFailAt =
  | 'assignment'
  | 'subscription'
  | 'payment'
  | 'movement'
  | 'audit';

export interface ConfirmExecutionDeps {
  drafts: NewSaleDraftStore;
  store: MockStore;
  statusOf?: AccountStatusResolver;
  capacityOverrides?: Record<string, number>;
  clock?: SaleClock;
  /** Current policy tables (production passes the vigente ones). */
  priceTable?: PriceTable;
  costTable?: CostTable;
  /** Test hook: fail the commit at one stage (proves full rollback). */
  failAt?: ConfirmFailAt;
  /** Technical-failure alerts only (safe summary, never secrets). */
  onAlert?: (alert: { title: string; summary: string }) => void;
}

export interface SaleConfirmation {
  operation: SaleLedgerOperation;
  subscriptionId: string;
  paymentId: string;
  movementId: string;
  startsOn: string;
  expiresOn: string;
  /** Credential bundle built ONLY post-confirm (never before). */
  bundle: CredentialBundle;
  /** wa.me delivery URL, or undefined when no usable E.164 exists. */
  whatsappUrl: string | undefined;
  whatsappText: string;
}

export type ConfirmOutcome =
  | {
      ok: true;
      kind: 'confirmed' | 'already-confirmed';
      confirmation: SaleConfirmation;
      text: string;
    }
  | { ok: false; kind: 'no-draft'; draft: null; text: string }
  | { ok: false; kind: 'incomplete'; draft: NewSaleDraft; missing: string; text: string }
  | { ok: false; kind: 'version-conflict'; draft: NewSaleDraft; text: string }
  | { ok: false; kind: 'emergency-auth'; draft: NewSaleDraft; text: string }
  | {
      ok: false;
      kind: 'recalculated';
      draft: NewSaleDraft;
      reason: 'inventory-changed' | 'price-changed';
      text: string;
    }
  | { ok: false; kind: 'no-inventory'; draft: NewSaleDraft; text: string }
  | { ok: false; kind: 'failed'; draft: NewSaleDraft; reason: string; text: string };

export interface ConfirmOpts {
  /** Optimistic version check: stale callers get version-conflict. */
  expectedVersion?: number;
}

const NO_DRAFT_TEXT = 'No hay borrador de venta abierto.';

function datePart(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Adds calendar months to a `YYYY-MM-DD` (UTC, day-clamped: Jan 31 + 1
 * month → Feb 28/29). Months only — no daily proration, no invented
 * promos (BR-FLW-006 / BR-REN-010 stay pending decisions).
 */
export function addMonthsUTC(startsOn: string, months: number): string {
  const [year, month, day] = startsOn.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year as number, (month as number) - 1 + months, 1));
  const daysInTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day as number, daysInTarget));
  return target.toISOString().slice(0, 10);
}

function draftMissing(draft: NewSaleDraft): string | null {
  if (draft.service === null) {
    return 'service';
  }
  if (draft.modality === null) {
    return 'modality';
  }
  if (draft.customer.existingCustomerId === undefined && draft.customer.proposedCustomer === undefined) {
    return 'customer';
  }
  if (draft.duration.requestedMonths === null || draft.duration.grantedMonths === null) {
    return 'months';
  }
  if (draft.payment.method === null) {
    return 'method';
  }
  if (draft.payment.actualAmount === null) {
    return 'amount';
  }
  if (draft.payment.receivedBy === null) {
    return 'receiver';
  }
  // Proposal/price/cost are NOT asked: a null or stale proposal goes
  // through fresh inventory selection below (recalc or Sin inventario).
  return null;
}

function customerNameFor(draft: NewSaleDraft, rows: MockAccount[]): string {
  if (draft.customer.proposedCustomer !== undefined) {
    return draft.customer.proposedCustomer.name;
  }
  if (draft.customer.existingCustomerId !== undefined) {
    const found = groupRowsIntoCustomers(rows).find(
      (customer) => customer.id === draft.customer.existingCustomerId,
    );
    if (found !== undefined) {
      return found.nombre;
    }
  }
  return draft.phone ?? '—';
}

function inventoryOptsOf(deps: ConfirmExecutionDeps): {
  statusOf?: AccountStatusResolver;
  capacityOverrides?: Record<string, number>;
} {
  return {
    ...(deps.statusOf !== undefined ? { statusOf: deps.statusOf } : {}),
    ...(deps.capacityOverrides !== undefined ? { capacityOverrides: deps.capacityOverrides } : {}),
  };
}

function fail(stage: ConfirmFailAt, failAt: ConfirmFailAt | undefined): void {
  if (failAt === stage) {
    throw new Error(`injected confirm failure at ${stage}`);
  }
}

function buildConfirmation(
  store: MockStore,
  operation: SaleLedgerOperation,
  customerPhoneRaw: string,
): SaleConfirmation {
  const row = store.accounts[operation.rowIndex] as MockAccount;
  const bundles = buildCredentialBundles([row], store.accounts);
  const bundle = bundles[0] as CredentialBundle;
  const target = resolveWhatsAppTarget(bundle.customerPhones, customerPhoneRaw);
  const whatsappText = renderCredentialWhatsAppText(bundle);
  const whatsappUrl =
    target.kind === 'direct' ? buildWhatsAppUrl(target.identity, whatsappText) : undefined;
  return {
    operation,
    subscriptionId: `sub-${operation.operationId}`,
    paymentId: `pay-${operation.operationId}`,
    movementId: `mov-${operation.operationId}`,
    startsOn: operation.startsOn,
    expiresOn: operation.expiresOn,
    bundle,
    whatsappUrl,
    whatsappText,
  };
}

function confirmationText(
  summaryText: string,
  confirmation: SaleConfirmation,
  already: boolean,
): string {
  // Post-sale Datos reuses the Fase 3 credential card EXACTLY (Netflix
  // PIN/expiry templates) — the summary alone never carries secrets, the
  // confirmed single card does (post-confirm delivery only).
  const datos = renderCredentialCard({
    serviceLabel: confirmation.bundle.serviceLabel,
    accountIdentifier: confirmation.bundle.accountIdentifier,
    accountPassword: confirmation.bundle.accountPassword,
    profile: confirmation.bundle.profile,
    accountType: confirmation.bundle.accountType,
    customerName: confirmation.bundle.customerName,
    fechaFin: confirmation.bundle.fechaFin,
    ...(confirmation.bundle.pin !== undefined ? { pin: confirmation.bundle.pin } : {}),
  });
  const whatsappLine =
    confirmation.whatsappUrl !== undefined
      ? '\n\n💬 WhatsApp preparado.'
      : `\n\n${WHATSAPP_NO_NUMBER_TEXT}`;
  return `${renderSaleConfirmed(summaryText, datos, already)}${whatsappLine}`;
}

/**
 * Executes one NewSale draft atomically (see module docstring). Synchronous
 * by design: check-then-mutate runs without interleaving, so same-slot
 * races resolve sequentially (first wins, second revalidates).
 */
export function confirmNewSale(
  owner: DraftOwner,
  deps: ConfirmExecutionDeps,
  summaryFor: (draft: NewSaleDraft) => string,
  opts: ConfirmOpts = {},
): ConfirmOutcome {
  const draft = deps.drafts.get(owner);
  if (draft === undefined) {
    const confirmedDraft = deps.drafts.confirmed(owner);
    if (confirmedDraft !== undefined) {
      const stored = deps.store.findSaleOperation(confirmedDraft.operationId);
      if (stored !== undefined) {
        const confirmation = buildConfirmation(deps.store, stored, confirmedDraft.phone ?? '');
        return {
          ok: true,
          kind: 'already-confirmed',
          confirmation,
          text: confirmationText(summaryFor(confirmedDraft), confirmation, true),
        };
      }
    }
    return { ok: false, kind: 'no-draft', draft: null, text: NO_DRAFT_TEXT };
  }

  // Idempotency first: the operation already executed — answer without
  // duplicating a single row (double Confirm, repeat callbacks).
  const existing = deps.store.findSaleOperation(draft.operationId);
  if (existing !== undefined) {
    deps.drafts.confirmSale(owner);
    const confirmation = buildConfirmation(deps.store, existing, draft.phone ?? '');
    return {
      ok: true,
      kind: 'already-confirmed',
      confirmation,
      text: confirmationText(summaryFor(draft), confirmation, true),
    };
  }

  if (opts.expectedVersion !== undefined && opts.expectedVersion !== draft.version) {
    return {
      ok: false,
      kind: 'version-conflict',
      draft,
      text: `🔄 El borrador cambió (versión ${draft.version}). Revisa el resumen actual y confirma de nuevo.\n\n${summaryFor(draft)}`,
    };
  }

  const missing = draftMissing(draft);
  if (missing !== null) {
    return {
      ok: false,
      kind: 'incomplete',
      draft,
      missing,
      text: `🧾 Falta un dato para confirmar (${missing}). Completa la venta antes de confirmar.`,
    };
  }

  // Emergency gate: explicit auth action first, never bundled with confirm.
  if (
    draft.proposalAwaitingEmergencyAuth ||
    (draft.proposal !== null && draft.proposal.emergencyRequired && !draft.proposal.emergencyAuthorized)
  ) {
    return { ok: false, kind: 'emergency-auth', draft, text: SALE_CONFIRM_REFUSED_TEXT };
  }

  const priceTable = deps.priceTable ?? PRICE_TABLE_V1;
  const costTable = deps.costTable ?? COST_TABLE_V1;
  const modality = draft.modality as SaleModality;
  const granted = draft.duration.grantedMonths as number;
  const liveRows = deps.store.accounts;

  const priceStale =
    draft.price === null ||
    draft.cost === null ||
    draft.price.policyId !== priceTable.policyId ||
    draft.price.policyVersion !== priceTable.policyVersion ||
    draft.cost.policyId !== costTable.policyId ||
    draft.cost.policyVersion !== costTable.policyVersion;
  const evidenceStale =
    draft.proposal === null ||
    !revalidateProposal(liveRows, draft.proposal.evidence, inventoryOptsOf(deps)).ok;

  // Revalidation at confirm (BR-SAL-007, BR-OPS-005, BR-SAL-010): a null
  // proposal, a stale policy, or a drifted slot all reselect fresh —
  // recalc + new summary + re-confirm, or Sin inventario fail-closed.
  // Never partial, never forced, and nothing is created on these paths.
  if (priceStale || evidenceStale) {
    const fresh =
      draft.modality === null
        ? ({ kind: 'none', reason: 'no-commercial-or-emergency' } as const)
        : selectInventory(liveRows, modality, inventoryOptsOf(deps));
    if (fresh.kind === 'none') {
      const cleared = attachProposal(draft, fresh, null);
      deps.drafts.save(cleared);
      return {
        ok: false,
        kind: 'no-inventory',
        draft: cleared,
        text: '🧾 VENTA NUEVA\n\nNo hay inventario disponible.\n\nPuedes revisar inventario, volver o cancelar.',
      };
    }
    const next = attachProposal(draft, fresh, {
      price: priceSnapshotFor(modality, granted, { price: priceTable }),
      cost: costSnapshotFor(modality, granted, { cost: costTable }),
    });
    deps.drafts.save(next);
    if (fresh.kind === 'emergency-auth-required') {
      return { ok: false, kind: 'emergency-auth', draft: next, text: SALE_CONFIRM_REFUSED_TEXT };
    }
    const sameSlot =
      draft.proposal !== null && fresh.candidate.slotId === draft.proposal.slotId;
    if (sameSlot && priceStale) {
      return {
        ok: false,
        kind: 'recalculated',
        draft: next,
        reason: 'price-changed',
        text: `🔄 La política de precios cambió — nuevo resumen:\n\n${summaryFor(next)}`,
      };
    }
    return {
      ok: false,
      kind: 'recalculated',
      draft: next,
      reason: 'inventory-changed',
      text: `🔄 El inventario cambió — nuevo resumen:\n\n${summaryFor(next)}`,
    };
  }

  const proposal = draft.proposal as NonNullable<NewSaleDraft['proposal']>;

  // ---- Atomic commit (all-or-nothing, in-memory, sync) ----
  const clock = deps.clock ?? systemSaleClock;
  const startsOn = datePart(clock.now());
  const expiresOn = addMonthsUTC(startsOn, granted);
  const confirmedAt = clock.now().toISOString();
  const customerName = customerNameFor(draft, liveRows);
  const customerPhone =
    draft.customer.proposedCustomer?.phone ?? draft.phone ?? '';
  const customerId =
    draft.customer.existingCustomerId ?? customerName.trim().toLowerCase();
  const price = draft.price as NonNullable<NewSaleDraft['price']>;
  const cost = draft.cost as NonNullable<NewSaleDraft['cost']>;
  const payment = {
    actualAmount: draft.payment.actualAmount as number,
    currency: draft.payment.currency as PaymentCurrency,
    method: draft.payment.method as PaymentMethod,
    receivedBy: draft.payment.receivedBy as string,
    ...(draft.payment.reference !== undefined ? { reference: draft.payment.reference } : {}),
  };
  const service = draft.service as SaleService;

  const prevRow = { ...(liveRows[proposal.evidence.rowIndex] as MockAccount) };
  const cursor = deps.store.saleLedgerLengths();
  const ubicacionTouched: Array<{ rowIndex: number; prev: MockAccount }> = [];
  // Final CUSTOMER_LOCATION (display/detail only — PAIS_CUENTA on the
  // rows is never read or written by this path).
  const finalLocation =
    draft.customer.proposedCustomer?.location ?? draft.customer.locationUpdate?.to;
  try {
    fail('assignment', deps.failAt);
    deps.store.assignSaleSlot(proposal.evidence.rowIndex, {
      nombre: customerName,
      numero: customerPhone,
      fechaInicio: startsOn,
      fechaFin: expiresOn,
      // New-customer location persists ONLY here, at confirm (BR-SAL-009
      // — cancel/no-inventory never reach this call).
      ...(draft.customer.proposedCustomer?.location !== undefined
        ? { ubicacion: draft.customer.proposedCustomer.location.display }
        : {}),
    });
    // Existing-customer update: applied on confirm across the
    // customer's rows (no separate operation); kept (untouched) on
    // cancel because cancel never reaches this call.
    if (
      draft.customer.existingCustomerId !== undefined &&
      draft.customer.locationUpdate !== undefined
    ) {
      ubicacionTouched.push(
        ...deps.store.updateCustomerUbicacion(
          draft.customer.existingCustomerId,
          draft.customer.locationUpdate.to.display,
        ),
      );
    }
    fail('subscription', deps.failAt);
    fail('payment', deps.failAt);
    fail('movement', deps.failAt);
    const movement: SaleLedgerMovement = {
      id: `mov-${draft.operationId}`,
      operationId: draft.operationId,
      direction: 'IN',
      amount: payment.actualAmount,
      currency: payment.currency,
      holder: payment.receivedBy,
      createdAt: confirmedAt,
    };
    const ledgerPayment: SaleLedgerPayment = {
      id: `pay-${draft.operationId}`,
      operationId: draft.operationId,
      amount: payment.actualAmount,
      currency: payment.currency,
      method: payment.method,
      receivedBy: payment.receivedBy,
      ...(payment.reference !== undefined ? { reference: payment.reference } : {}),
      paidAt: confirmedAt,
    };
    const operation: SaleLedgerOperation = {
      operationId: draft.operationId,
      idempotencyKey: draft.operationId,
      type: 'NEW_SALE',
      operator: draft.operator,
      chatId: draft.owner.chatId,
      userId: draft.owner.userId,
      customerId,
      customerName,
      phone: customerPhone,
      ...(finalLocation !== undefined ? { customerLocation: { ...finalLocation } } : {}),
      service,
      modality,
      monthsRequested: draft.duration.requestedMonths as number,
      monthsGranted: granted,
      price,
      cost,
      payment,
      serviceAccountId: proposal.serviceAccountId,
      slotId: proposal.slotId,
      rowIndex: proposal.evidence.rowIndex,
      startsOn,
      expiresOn,
      status: 'CONFIRMED',
      confirmedAt,
    };
    fail('audit', deps.failAt);
    const audit: SaleLedgerAudit = {
      operationId: draft.operationId,
      type: 'sale.confirmed',
      operator: draft.operator,
      chatId: draft.owner.chatId,
      userId: draft.owner.userId,
      at: confirmedAt,
      refs: {
        serviceAccountId: proposal.serviceAccountId,
        slotId: proposal.slotId,
        modality,
        months: granted,
        amount: payment.actualAmount,
        currency: payment.currency,
        method: payment.method,
        receivedBy: payment.receivedBy,
        customerName,
      },
    };
    deps.store.pushSaleRecords({
      operation,
      item: {
        id: `item-${draft.operationId}`,
        operationId: draft.operationId,
        subscriptionId: `sub-${draft.operationId}`,
        serviceAccountId: proposal.serviceAccountId,
        slotId: proposal.slotId,
      },
      subscription: {
        id: `sub-${draft.operationId}`,
        operationId: draft.operationId,
        customerId,
        customerName,
        phone: customerPhone,
        serviceAccountId: proposal.serviceAccountId,
        slotId: proposal.slotId,
        perfil: proposal.evidence.perfil,
        startsOn,
        expiresOn,
        months: granted,
        price,
        cost,
      },
      payment: ledgerPayment,
      movement,
      audit,
    });
    deps.drafts.confirmSale(owner);
    const confirmation = buildConfirmation(deps.store, operation, customerPhone);
    return {
      ok: true,
      kind: 'confirmed',
      confirmation,
      text: confirmationText(summaryFor({ ...draft, status: 'CONFIRMED' }), confirmation, false),
    };
  } catch (error) {
    deps.store.restoreSaleSlot(proposal.evidence.rowIndex, prevRow);
    for (const touched of ubicacionTouched) {
      deps.store.restoreSaleSlot(touched.rowIndex, touched.prev);
    }
    deps.store.truncateSaleLedger(cursor);
    const reason = error instanceof Error ? error.message : 'unknown confirm failure';
    deps.onAlert?.({
      title: 'Venta no registrada',
      summary: `La venta ${draft.operationId} no se registró (${reason}). El borrador sigue abierto.`,
    });
    return {
      ok: false,
      kind: 'failed',
      draft,
      reason,
      text: '⚠️ La venta no pudo registrarse por un fallo técnico. No se guardó nada — el borrador sigue abierto.',
    };
  }
}

/** Policy constants for version assertions in tests and summaries. */
export const SALE_PRICE_POLICY_REF = `${PRICE_POLICY_ID} ${PRICE_POLICY_VERSION}` as const;
export const SALE_COST_POLICY_REF = `${COST_POLICY_ID} ${COST_POLICY_VERSION}` as const;

export { PRICE_POLICY_ID, PRICE_POLICY_VERSION, COST_POLICY_ID, COST_POLICY_VERSION };

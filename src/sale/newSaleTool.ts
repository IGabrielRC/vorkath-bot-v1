/**
 * `prepareNewSale` — the ONE entry point for NewSale proposals (Slice A).
 *
 * Button taps and natural-language requests converge here (transversal
 * button≡NL contract): NL arrives via `prepareNewSaleFromText`
 * (deterministic `parseSaleExtraction`), buttons via
 * `prepareNewSaleFromAction` with structured input — both fold into the
 * SAME draft through the SAME inventory/pricing/payment core. Gemini
 * never executes; it only interprets (Slice B routing) into the params
 * this tool consumes.
 *
 * Slice A scope: draft + proposal + summary. Confirm EXECUTION refuses
 * (`SALE_CONFIRM_REFUSED_TEXT`, Slice B); cancel executes the domain
 * cancel (drops the draft, persists nothing); emergency authorization is
 * an explicit separate action, never bundled with sale confirmation.
 *
 * Lookup safety (BR-CUS-009): customer resolution is READ-ONLY. Unknown
 * phones yield the in-sale new-customer prompt; `proposedCustomer` lives
 * in the draft and no customer write path exists in this module.
 */

import type { Customer } from '../mock/customers';
import { groupRowsIntoCustomers } from '../mock/customers';
import type { MockAccount } from '../mock/excelLoader';
import {
  renderEmergencyInventoryCard,
  renderNewCustomerSalePrompt,
  renderNewSaleSummary,
  renderSaleAskMissing,
  renderSaleNoInventory,
  renderSaleSplitRefused,
  renderSaleUnsupportedNetflixComplete,
  type RenderedNewSaleSummary,
} from '../telegram/render';
import {
  SALE_CONFIRM_REFUSED_TEXT,
  applySalePatch,
  attachProposal,
  authorizeEmergency,
  type DraftOwner,
  type NewSaleDraft,
  type NewSaleDraftStore,
  type SalePatch,
} from './newSaleDraft';
import {
  currencyForMethod,
  labelForMethod,
  matchCashHolder,
  resolveCashHolders,
} from './payments';
import { costSnapshotFor, priceSnapshotFor, type SaleModality } from './pricePolicy';
import {
  selectInventory,
  type AccountStatusResolver,
  type InventoryProposal,
} from './inventory';
import { missingSaleFields, parseSaleExtraction, type SaleExtraction } from './saleParser';

export interface SaleActor extends DraftOwner {
  name: string;
}

export interface SaleDeps {
  store: NewSaleDraftStore;
  /** Read-only lookup (repos-backed in production, fixture-backed in tests). */
  findCustomersByPhone: (phoneRaw: string) => Promise<Customer[]> | Customer[];
  inventoryRows: MockAccount[];
  statusOf?: AccountStatusResolver;
  capacityOverrides?: Record<string, number>;
  /** Resolved holder set; defaults to the documented pair. */
  cashHolders?: string[];
}

export type SaleResultKind =
  | 'summary'
  | 'ask-missing'
  | 'new-customer'
  | 'disambiguate'
  | 'emergency-auth'
  | 'no-inventory'
  | 'clarification'
  | 'unsupported'
  | 'cancelled'
  | 'confirm-refused';

export interface SaleResult {
  kind: SaleResultKind;
  draft: NewSaleDraft | null;
  text: string;
  /** Present on `ask-missing` (first missing field). */
  missing?: string;
  /** Present on `disambiguate` (operator picks one). */
  customers?: Customer[];
}

function holdersOf(deps: SaleDeps): string[] {
  return deps.cashHolders ?? resolveCashHolders();
}

function customerDisplayName(draft: NewSaleDraft, deps: SaleDeps): string {
  if (draft.customer.proposedCustomer !== undefined) {
    return draft.customer.proposedCustomer.name;
  }
  if (draft.customer.existingCustomerId !== undefined) {
    const found = groupRowsIntoCustomers(deps.inventoryRows).find(
      (customer) => customer.id === draft.customer.existingCustomerId,
    );
    if (found !== undefined) {
      return found.nombre;
    }
  }
  return draft.phone ?? '—';
}

function summaryText(draft: NewSaleDraft, deps: SaleDeps): string {
  const granted = draft.duration.grantedMonths;
  const input: RenderedNewSaleSummary = {
    customerName: customerDisplayName(draft, deps),
    phone: draft.phone ?? '—',
    isNewCustomer: draft.customer.proposedCustomer !== undefined,
    modality: draft.modality ?? '?',
    requestedMonths: draft.duration.requestedMonths ?? 0,
    grantedMonths: granted ?? 0,
    ...(draft.proposal !== null
      ? {
          assignment: `${draft.proposal.serviceAccountId} · ${draft.proposal.evidence.perfil}`,
          emergencyPending: draft.proposal.emergencyRequired && !draft.proposal.emergencyAuthorized,
        }
      : {}),
    suggestedAmount: draft.price?.suggestedAmount ?? null,
    ...(draft.price !== null ? { suggestedCurrency: draft.price.currency } : {}),
    actualAmount: draft.payment.actualAmount,
    currency: draft.payment.currency,
    methodLabel: draft.payment.method !== null ? labelForMethod(draft.payment.method) : null,
    receivedBy: draft.payment.receivedBy,
    ...(draft.payment.reference !== undefined ? { reference: draft.payment.reference } : {}),
    ...(draft.price !== null
      ? { pricePolicy: `${draft.price.policyId} ${draft.price.policyVersion}` }
      : {}),
  };
  void granted;
  return renderNewSaleSummary(input);
}

/** Re-runs inventory + snapshots after any draft change (corrections recalc). */
function refreshProposal(draft: NewSaleDraft, deps: SaleDeps): NewSaleDraft {
  if (draft.service === null || draft.modality === null) {
    return draft;
  }
  const proposal: InventoryProposal = selectInventory(deps.inventoryRows, draft.modality, {
    ...(deps.statusOf !== undefined ? { statusOf: deps.statusOf } : {}),
    ...(deps.capacityOverrides !== undefined ? { capacityOverrides: deps.capacityOverrides } : {}),
  });
  if (proposal.kind === 'none' || draft.duration.grantedMonths === null) {
    return attachProposal(draft, proposal, null);
  }
  const modality = draft.modality as SaleModality;
  return attachProposal(draft, proposal, {
    price: priceSnapshotFor(modality, draft.duration.grantedMonths),
    cost: costSnapshotFor(modality, draft.duration.grantedMonths),
  });
}

function draftMissingField(draft: NewSaleDraft): string | null {
  if (draft.service === null) {
    return 'service';
  }
  if (draft.modality === null) {
    return 'modality';
  }
  if (draft.customer.existingCustomerId === undefined && draft.customer.proposedCustomer === undefined) {
    return 'customer';
  }
  if (draft.duration.requestedMonths === null) {
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
  return null;
}

/** Decides the conversational result for the current draft state. */
function settle(draft: NewSaleDraft, deps: SaleDeps, customers?: Customer[]): SaleResult {
  if (draft.proposalAwaitingEmergencyAuth && draft.proposal !== null) {
    return {
      kind: 'emergency-auth',
      draft,
      text:
        `${renderEmergencyInventoryCard({
          identifier: draft.proposal.serviceAccountId,
          perfil: draft.proposal.evidence.perfil,
        })}\n\n${summaryText(draft, deps)}`,
    };
  }
  if (
    draft.service !== null &&
    draft.modality !== null &&
    draft.proposal === null &&
    !draft.proposalAwaitingEmergencyAuth
  ) {
    return { kind: 'no-inventory', draft, text: renderSaleNoInventory() };
  }
  if (customers !== undefined && customers.length > 1) {
    const lines = customers.map((customer) => `• ${customer.nombre} — ${customer.phones.join(' / ')}`);
    return {
      kind: 'disambiguate',
      draft,
      customers,
      text: `🧾 Venta nueva — ese número tiene varios clientes. Elige uno:\n${lines.join('\n')}`,
    };
  }
  const missing = draftMissingField(draft);
  if (missing !== null) {
    return { kind: 'ask-missing', draft, missing, text: renderSaleAskMissing(missing) };
  }
  return { kind: 'summary', draft, text: summaryText(draft, deps) };
}

async function resolvePhone(
  draft: NewSaleDraft,
  phoneRaw: string,
  deps: SaleDeps,
): Promise<{ draft: NewSaleDraft; customers: Customer[] }> {
  const customers = await deps.findCustomersByPhone(phoneRaw);
  const { draft: patched } = applySalePatch(draft, {
    phone: phoneRaw,
    existingCustomerId: null,
    proposedCustomer: null,
  });
  if (customers.length === 1 && customers[0] !== undefined) {
    const { draft: linked } = applySalePatch(patched, { existingCustomerId: customers[0].id });
    return { draft: linked, customers };
  }
  return { draft: patched, customers };
}

/**
 * NL entry: folds one operator sentence into the actor's draft.
 * Full-combo extracts everything; partial asks only missing;
 * corrections recalc the SAME draft (operationId stable).
 */
export async function prepareNewSaleFromText(
  actor: SaleActor,
  text: string,
  deps: SaleDeps,
): Promise<SaleResult> {
  const { draft: base } = deps.store.create(
    { chatId: actor.chatId, userId: actor.userId, ...(actor.name !== '' ? { name: actor.name } : {}) },
    actor.name,
  );
  const extraction: SaleExtraction = parseSaleExtraction(text);

  if (extraction.unsupported !== undefined) {
    const { draft } = applySalePatch(base, { service: 'netflix', modality: null });
    deps.store.save(draft);
    return { kind: 'unsupported', draft, text: renderSaleUnsupportedNetflixComplete() };
  }
  if (extraction.splitAttempt) {
    deps.store.save(base);
    return { kind: 'clarification', draft: base, text: renderSaleSplitRefused() };
  }

  const holders = holdersOf(deps);
  let receiver: string | null | undefined;
  let receiverUnknown: string | undefined;
  if (extraction.receiverRaw !== undefined) {
    const matched = matchCashHolder(extraction.receiverRaw, holders);
    if (matched !== undefined) {
      receiver = matched;
    } else {
      receiverUnknown = extraction.receiverRaw;
    }
  }

  const method = extraction.method;
  const currency =
    extraction.amountCurrency ?? (method !== undefined ? currencyForMethod(method) : undefined);

  const patch: SalePatch = {
    ...(extraction.service !== undefined ? { service: extraction.service } : {}),
    ...(extraction.modality !== undefined ? { modality: extraction.modality } : {}),
    ...(extraction.months !== undefined ? { requestedMonths: extraction.months } : {}),
    ...(extraction.amount !== undefined ? { actualAmount: extraction.amount } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(receiver !== undefined ? { receivedBy: receiver } : {}),
    ...(extraction.referenceRaw !== undefined ? { reference: extraction.referenceRaw } : {}),
  };
  let { draft } = applySalePatch(base, patch);

  if (receiverUnknown !== undefined) {
    deps.store.save(refreshProposal(draft, deps));
    const saved = deps.store.get({ chatId: actor.chatId, userId: actor.userId });
    const current = saved ?? draft;
    return {
      kind: 'clarification',
      draft: current,
      text: `🧾 No reconozco a «${receiverUnknown}» como receptor. ¿Quién recibió: ${holders.join(' o ')}?`,
    };
  }

  if (extraction.phoneRaw !== undefined) {
    const resolved = await resolvePhone(draft, extraction.phoneRaw, deps);
    draft = resolved.draft;
    deps.store.save(refreshProposal(draft, deps));
    const current = deps.store.get({ chatId: actor.chatId, userId: actor.userId }) ?? draft;
    if (resolved.customers.length === 0) {
      return {
        kind: 'new-customer',
        draft: current,
        text: renderNewCustomerSalePrompt(extraction.phoneRaw),
      };
    }
    return settle(current, deps, resolved.customers);
  }

  deps.store.save(refreshProposal(draft, deps));
  const current = deps.store.get({ chatId: actor.chatId, userId: actor.userId }) ?? draft;
  if (
    current.phone !== null &&
    current.customer.existingCustomerId === undefined &&
    current.customer.proposedCustomer === undefined
  ) {
    const customers = await deps.findCustomersByPhone(current.phone);
    if (customers.length === 0) {
      return { kind: 'new-customer', draft: current, text: renderNewCustomerSalePrompt(current.phone) };
    }
    return settle(current, deps, customers);
  }
  return settle(current, deps);
}

export type SaleAction =
  | { type: 'provide-name'; name: string; location?: string }
  | { type: 'select-customer'; customerId: string }
  | { type: 'authorize-emergency' }
  | { type: 'cancel-sale' }
  | { type: 'confirm-sale' };

/**
 * Button entry: structured actions onto the SAME draft core (button≡NL).
 * Slice B attaches real keyboards to these; the logic already holds.
 */
export async function prepareNewSaleFromAction(
  actor: SaleActor,
  action: SaleAction,
  deps: SaleDeps,
): Promise<SaleResult> {
  const owner = { chatId: actor.chatId, userId: actor.userId };
  if (action.type === 'confirm-sale') {
    const draft = deps.store.get(owner) ?? null;
    return { kind: 'confirm-refused', draft, text: SALE_CONFIRM_REFUSED_TEXT };
  }
  if (action.type === 'cancel-sale') {
    const had = deps.store.get(owner) !== undefined;
    deps.store.cancel(owner);
    void had;
    return { kind: 'cancelled', draft: null, text: '❌ Venta cancelada. No se guardó nada.' };
  }
  const current = deps.store.get(owner);
  if (current === undefined) {
    return { kind: 'clarification', draft: null, text: 'No hay borrador de venta abierto.' };
  }
  if (action.type === 'authorize-emergency') {
    const authorized = authorizeEmergency(current);
    if (authorized === undefined) {
      return { kind: 'clarification', draft: current, text: 'No hay emergencia pendiente de autorizar.' };
    }
    deps.store.save(authorized);
    return settle(authorized, deps);
  }
  if (action.type === 'select-customer') {
    const { draft } = applySalePatch(current, { existingCustomerId: action.customerId });
    deps.store.save(refreshProposal(draft, deps));
    const saved = deps.store.get(owner) ?? draft;
    return settle(saved, deps);
  }
  const { draft } = applySalePatch(current, {
    proposedCustomer: {
      name: action.name,
      phone: current.phone ?? '',
      ...(action.location !== undefined ? { location: action.location } : {}),
    },
  });
  deps.store.save(refreshProposal(draft, deps));
  const saved = deps.store.get(owner) ?? draft;
  return settle(saved, deps);
}

/** Re-export for the Slice B wiring (missing-field catalogue in one place). */
export { missingSaleFields };

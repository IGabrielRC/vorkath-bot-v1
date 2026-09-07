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
 *
 * TRANSVERSAL INVARIANT (phases 5-15): ASK ALL CURRENTLY-REQUIRED
 * MISSING INFO IN THE SMALLEST TURNS — group independent fields into
 * ONE batched card (`missingFields` + combined example); go sequential
 * (one primary expected field) ONLY when a decision conditions the
 * rest (service/modality choice, emergency auth).
 */

import type { Customer } from '../mock/customers';
import { groupRowsIntoCustomers } from '../mock/customers';
import type { MockAccount } from '../mock/excelLoader';
import type { MockStore } from '../mock/mockStore';
import {
  renderEmergencyInventoryCard,
  renderNewCustomerSalePrompt,
  renderNewSaleSummary,
  renderSaleAskMissing,
  renderSaleAskMissingBatch,
  renderSaleNoInventory,
  renderSaleSplitRefused,
  renderSaleUnsupportedNetflixComplete,
  type RenderedNewSaleSummary,
} from '../telegram/render';
import {
  confirmNewSale,
  type ConfirmFailAt,
  type SaleClock,
} from './newSaleConfirm';
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
import { missingSaleFields, parseSaleExtraction, extractNameRemainder } from './saleParser';
import type { SaleExtraction } from './saleParser';

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
  /**
   * Slice B execution seam (opt-in): when present, `confirm-sale` runs
   * the atomic `confirmNewSale` service against this MockStore.
   * Absent → Slice A refusal (`confirm-refused`, zero side-effects).
   */
  saleExec?: SaleExecDeps;
}

/**
 * Slice B execution options for `confirm-sale` (domain/service +
 * MockStore seam — the Telegram layer never touches these directly).
 */
export interface SaleExecDeps {
  mockStore: MockStore;
  clock?: SaleClock;
  statusOf?: AccountStatusResolver;
  capacityOverrides?: Record<string, number>;
  priceTable?: import('./pricePolicy').PriceTable;
  costTable?: import('./pricePolicy').CostTable;
  failAt?: ConfirmFailAt;
  onAlert?: (alert: { title: string; summary: string }) => void;
}

/**
 * Renewal hold reply (Fase 5 reserved): `recarga`/`renueva` sentences
 * are NEVER a NEW_SALE. Safe response, zero invention, zero draft.
 */
export const RENEWAL_HOLD_TEXT =
  '🔄 Las renovaciones aún no están disponibles. Puedo venderte una cuenta nueva: dime servicio y modalidad.';

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
  | 'confirmed'
  | 'already-confirmed'
  | 'confirm-refused';

export interface SaleResult {
  kind: SaleResultKind;
  draft: NewSaleDraft | null;
  text: string;
  /** Present on `ask-missing` (primary missing field — sequential decisions only). */
  missing?: string;
  /** Present on `ask-missing`: ALL currently-required missing fields (batched card). */
  missingFields?: string[];
  /** Present on `disambiguate` (operator picks one). */
  customers?: Customer[];
  /** Present on `confirmed`/`already-confirmed` (wa.me URL, post-confirm only). */
  whatsappUrl?: string;
}

function holdersOf(deps: SaleDeps): string[] {
  return deps.cashHolders ?? resolveCashHolders();
}

function customerDisplayName(draft: NewSaleDraft, deps: { inventoryRows: MockAccount[] }): string {
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
  return renderSaleDraftSummary(draft, deps.inventoryRows, deps);
}

/**
 * Single-card summary renderer (Slice B export): the SAME summary the
 * pre-confirm card shows, reused for recalculated + confirmed cards so
 * the card never forks copy. Credential-free by construction (the input
 * type carries no secret field).
 */
export function renderSaleDraftSummary(
  draft: NewSaleDraft,
  rows: MockAccount[],
  deps?: Pick<SaleDeps, 'inventoryRows'>,
): string {
  const source = deps?.inventoryRows ?? rows;
  const granted = draft.duration.grantedMonths;
  const input: RenderedNewSaleSummary = {
    customerName: customerDisplayName(draft, { inventoryRows: source }),
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

/**
 * ALL currently-required missing fields in ask order (service →
 * modality → customer/phone → months → method → amount → receiver).
 * The batched card asks every entry at once; `draftMissingField`
 * (first entry) stays the primary for sequential scopes only.
 */
function missingSaleFieldList(draft: NewSaleDraft): string[] {
  const missing: string[] = [];
  if (draft.service === null) {
    missing.push('service');
  }
  if (draft.modality === null) {
    missing.push('modality');
  }
  if (draft.customer.existingCustomerId === undefined && draft.customer.proposedCustomer === undefined) {
    missing.push('customer');
  }
  if (draft.duration.requestedMonths === null) {
    missing.push('months');
  }
  if (draft.payment.method === null) {
    missing.push('method');
  }
  if (draft.payment.actualAmount === null) {
    missing.push('amount');
  }
  if (draft.payment.receivedBy === null) {
    missing.push('receiver');
  }
  return missing;
}

function draftMissingField(draft: NewSaleDraft): string | null {
  return missingSaleFieldList(draft)[0] ?? null;
}

/**
 * Expected-field design: each sale view declares the fields it is
 * waiting for. `expectedSaleField` (primary = first missing) is kept
 * for the sequential scopes (service/modality choice, emergency auth,
 * single-missing fill); `expectedSaleFields` (ALL missing) drives the
 * batched card and the multi-answer parse. The webhook consumes these
 * BEFORE the global router so a natural answer (one field or many —
 * "Gabriel Juan", "30 días", "Zelle, 4 dólares, lo recibió Edward"…)
 * fills the draft instead of being stolen by global search. Exported
 * for the router; the single source of truth stays
 * `missingSaleFieldList`.
 */
export function expectedSaleField(draft: NewSaleDraft): string | null {
  return draftMissingField(draft);
}

/** ALL currently-required missing fields (batched card source). */
export function expectedSaleFields(draft: NewSaleDraft): string[] {
  return missingSaleFieldList(draft);
}

/**
 * Confirmar gating: true only when the draft is fully ready —
 * fields + proposal + price + cost + payment + receiver + customer +
 * duration, with no pending emergency auth. The keyboard layer shows
 * Confirmar/Corregir ONLY on ready drafts; incomplete drafts get
 * Volver/Cancelar + valid next actions.
 */
export function isSaleReady(draft: NewSaleDraft): boolean {
  return (
    draftMissingField(draft) === null &&
    draft.proposal !== null &&
    !draft.proposalAwaitingEmergencyAuth &&
    !(draft.proposal.emergencyRequired && !draft.proposal.emergencyAuthorized) &&
    draft.price !== null &&
    draft.cost !== null
  );
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
  if (
    draft.phone !== null &&
    draft.customer.existingCustomerId === undefined &&
    draft.customer.proposedCustomer === undefined
  ) {
    // Phone known, customer not: the in-sale new-customer prompt (name),
    // never the generic phone question — BR-CUS-009, Gabriel Juan class.
    return {
      kind: 'new-customer',
      draft,
      text: renderNewCustomerSalePrompt(draft.phone),
    };
  }
  const missing = missingSaleFieldList(draft);
  // Sequential decisions condition everything downstream (inventory
  // precheck needs service+modality; emergency auth gates confirm), so
  // they keep the single-question card with its choice buttons — never
  // batched with independent fields.
  if (missing[0] === 'service' || missing[0] === 'modality') {
    const primary = missing[0];
    return {
      kind: 'ask-missing',
      draft,
      missing: primary,
      missingFields: [primary],
      text: renderSaleAskMissing(primary),
    };
  }
  if (missing.length === 1 && missing[0] !== undefined) {
    // Single missing: ask only it (primary expected field).
    return { kind: 'ask-missing', draft, missing: missing[0], missingFields: missing, text: renderSaleAskMissing(missing[0]) };
  }
  if (missing.length > 1 && missing[0] !== undefined) {
    // Independent fields: ONE batched card with ALL of them + a
    // combined example; the next parse recomputes and shows ONLY the
    // still-missing remainder (never re-asks resolved fields).
    return {
      kind: 'ask-missing',
      draft,
      missing: missing[0],
      missingFields: missing,
      text: renderSaleAskMissingBatch(missing),
    };
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
  const { draft: base, resumed } = deps.store.create(
    { chatId: actor.chatId, userId: actor.userId, ...(actor.name !== '' ? { name: actor.name } : {}) },
    actor.name,
  );
  const extraction: SaleExtraction = parseSaleExtraction(text);

  if (extraction.renewalHint === true) {
    // Renewal-reserved (Fase 5): NEVER a NEW_SALE. No draft is created,
    // nothing is folded — the caller answers the safe hold reply. A
    // just-created empty shell is dropped (an open draft from a
    // previous turn is never touched — the webhook holds its card).
    if (!resumed) {
      deps.store.cancel({ chatId: actor.chatId, userId: actor.userId });
    }
    return { kind: 'clarification', draft: null, text: RENEWAL_HOLD_TEXT };
  }

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

  // Scoped name remainder (multifield answers): when the open draft
  // already holds the phone but no customer, leftover name-like text
  // fills the proposed name in the SAME parse (`Gabriel Juan lo
  // recibió Edward` → name + receiver together). Name-vs-holder
  // collision: an EXACT holder-identity match wins for receiver;
  // remaining text becomes the customer name (never naive contains() —
  // `Eduardo` never matches holder `Edward`).
  let remainderName: string | undefined;
  if (
    base.phone !== null &&
    base.customer.existingCustomerId === undefined &&
    base.customer.proposedCustomer === undefined &&
    extraction.phoneRaw === undefined
  ) {
    const remainder = extractNameRemainder(text, extraction);
    if (remainder !== undefined) {
      const holderHit = matchCashHolder(remainder, holders);
      if (holderHit !== undefined) {
        if (receiver === undefined) {
          receiver = holderHit;
        }
      } else {
        remainderName = remainder;
      }
    }
  }

  // Bare holder word scoped to an open draft (`Edward` answering the
  // receiver question): exact holder-identity match fills the receiver
  // (the webhook maps it to `lo recibió …` first; this covers direct
  // tool entries). Fresh drafts ignore it — a stray name never opens
  // field state by itself.
  if (receiver === undefined && extraction.receiverRaw === undefined && resumed) {
    const bareHit = matchCashHolder(text.trim(), holders);
    if (bareHit !== undefined) {
      receiver = bareHit;
    }
  }

  const patch: SalePatch = {
    ...(extraction.service !== undefined ? { service: extraction.service } : {}),
    ...(extraction.modality !== undefined ? { modality: extraction.modality } : {}),
    ...(extraction.months !== undefined ? { requestedMonths: extraction.months } : {}),
    ...(extraction.amount !== undefined ? { actualAmount: extraction.amount } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(receiver !== undefined ? { receivedBy: receiver } : {}),
    ...(extraction.referenceRaw !== undefined ? { reference: extraction.referenceRaw } : {}),
    ...(remainderName !== undefined && base.phone !== null
      ? { proposedCustomer: { name: remainderName, phone: base.phone } }
      : {}),
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

  // Phone/customer linking stays BEFORE the precheck so the saved draft
  // is always complete for confirm revalidation — the precheck only
  // decides the conversational RESULT (no-inventory/emergency beat the
  // new-customer prompt and every ask-missing question).
  let linkedCustomers: Customer[] | undefined;
  if (extraction.phoneRaw !== undefined) {
    const resolved = await resolvePhone(draft, extraction.phoneRaw, deps);
    draft = resolved.draft;
    linkedCustomers = resolved.customers;
  }
  // Early inventory precheck: the moment service+modality resolve, the
  // deterministic precheck runs BEFORE any customer/payment question.
  // Zero → SIN INVENTARIO (asks nothing else); emergency-only →
  // emergency card (auth ≠ sale confirm preserved). Confirm still
  // revalidates at execution time.
  draft = refreshProposal(draft, deps);
  deps.store.save(draft);
  {
    const current = deps.store.get({ chatId: actor.chatId, userId: actor.userId }) ?? draft;
    if (current.service !== null && current.modality !== null) {
      if (current.proposalAwaitingEmergencyAuth && current.proposal !== null) {
        return {
          kind: 'emergency-auth',
          draft: current,
          text:
            `${renderEmergencyInventoryCard({
              identifier: current.proposal.serviceAccountId,
              perfil: current.proposal.evidence.perfil,
            })}\n\n${summaryText(current, deps)}`,
        };
      }
      if (current.proposal === null) {
        return { kind: 'no-inventory', draft: current, text: renderSaleNoInventory() };
      }
    }
  }

  // Method/currency conflict (never silent conversion): the sentence
  // states BOTH a method and an explicit foreign currency (`4 dólares
  // por Binance` states USD against Binance's native USDT). Both
  // stated values are kept as-is; a minimal clarification asks the
  // operator to resolve it — the draft is never silently reinterpreted.
  // Runs AFTER the inventory precheck (no-inventory/emergency win) and
  // BEFORE the phone/settle branches, but yields to identity: an
  // unknown or shared phone still asks customer first, the conflict
  // resurfacing on the next turn.
  if (
    method !== undefined &&
    extraction.amountCurrency !== undefined &&
    currencyForMethod(method) !== extraction.amountCurrency &&
    (linkedCustomers === undefined || linkedCustomers.length === 1)
  ) {
    const current = deps.store.get({ chatId: actor.chatId, userId: actor.userId }) ?? draft;
    const native = currencyForMethod(method);
    const amountBit = extraction.amount !== undefined ? `${extraction.amount} ` : '';
    return {
      kind: 'clarification',
      draft: current,
      text:
        `🧾 «${amountBit}${extraction.amountCurrency} por ${labelForMethod(method)}»: ` +
        `${labelForMethod(method)} usa ${native}. ¿Confirmamos ${amountBit}${native} ` +
        `por ${labelForMethod(method)} o fue otro método? Respóndelo en un mensaje.`,
    };
  }

  if (extraction.phoneRaw !== undefined) {
    const current = deps.store.get({ chatId: actor.chatId, userId: actor.userId }) ?? draft;
    const customers = linkedCustomers ?? [];
    if (customers.length === 0) {
      return {
        kind: 'new-customer',
        draft: current,
        text: renderNewCustomerSalePrompt(extraction.phoneRaw),
      };
    }
    return settle(current, deps, customers);
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
    // Slice B execution seam (opt-in): with `saleExec` the confirm runs
    // the atomic service; without it the Slice A refusal holds (zero
    // side-effects — locked by the Slice A contract tests).
    if (deps.saleExec === undefined) {
      const draft = deps.store.get(owner) ?? null;
      return { kind: 'confirm-refused', draft, text: SALE_CONFIRM_REFUSED_TEXT };
    }
    const summaryFor = (draft: NewSaleDraft): string =>
      renderSaleDraftSummary(draft, deps.saleExec?.mockStore.accounts ?? deps.inventoryRows, deps);
    const statusOf = deps.saleExec.statusOf ?? deps.statusOf;
    const capacityOverrides = deps.saleExec.capacityOverrides ?? deps.capacityOverrides;
    const outcome = confirmNewSale(
      { chatId: actor.chatId, userId: actor.userId, ...(actor.name !== '' ? { name: actor.name } : {}) },
      {
        drafts: deps.store,
        store: deps.saleExec.mockStore,
        ...(statusOf !== undefined ? { statusOf } : {}),
        ...(capacityOverrides !== undefined ? { capacityOverrides } : {}),
        ...(deps.saleExec.clock !== undefined ? { clock: deps.saleExec.clock } : {}),
        ...(deps.saleExec.priceTable !== undefined ? { priceTable: deps.saleExec.priceTable } : {}),
        ...(deps.saleExec.costTable !== undefined ? { costTable: deps.saleExec.costTable } : {}),
        ...(deps.saleExec.failAt !== undefined ? { failAt: deps.saleExec.failAt } : {}),
        ...(deps.saleExec.onAlert !== undefined ? { onAlert: deps.saleExec.onAlert } : {}),
      },
      summaryFor,
    );
    switch (outcome.kind) {
      case 'confirmed':
        return {
          kind: 'confirmed',
          draft: deps.store.confirmed(owner) ?? null,
          text: outcome.text,
          ...(outcome.confirmation.whatsappUrl !== undefined
            ? { whatsappUrl: outcome.confirmation.whatsappUrl }
            : {}),
        };
      case 'already-confirmed':
        return {
          kind: 'already-confirmed',
          draft: deps.store.confirmed(owner) ?? null,
          text: outcome.text,
          ...(outcome.confirmation.whatsappUrl !== undefined
            ? { whatsappUrl: outcome.confirmation.whatsappUrl }
            : {}),
        };
      case 'no-inventory':
        return { kind: 'no-inventory', draft: outcome.draft, text: outcome.text };
      case 'emergency-auth': {
        const draft = outcome.draft;
        return {
          kind: 'emergency-auth',
          draft,
          text:
            draft.proposal !== null
              ? `${renderEmergencyInventoryCard({
                  identifier: draft.proposal.serviceAccountId,
                  perfil: draft.proposal.evidence.perfil,
                })}\n\n${summaryFor(draft)}`
              : outcome.text,
        };
      }
      case 'recalculated':
      case 'version-conflict':
        return { kind: 'summary', draft: outcome.draft, text: outcome.text };
      case 'incomplete':
        return {
          kind: 'ask-missing',
          draft: outcome.draft,
          missing: outcome.missing,
          missingFields: [outcome.missing],
          text: renderSaleAskMissing(outcome.missing),
        };
      case 'failed':
        return { kind: 'clarification', draft: outcome.draft, text: outcome.text };
      case 'no-draft':
        return { kind: 'clarification', draft: null, text: outcome.text };
    }
  }
  if (action.type === 'cancel-sale') {
    const open = deps.store.get(owner);
    if (open === undefined) {
      // A confirmed sale is immutable — cancel never deletes its header
      // (repeat confirms must keep answering `already confirmed`).
      if (deps.store.confirmed(owner) !== undefined) {
        return {
          kind: 'clarification',
          draft: null,
          text: 'La venta ya está confirmada y no se puede cancelar.',
        };
      }
      return { kind: 'cancelled', draft: null, text: 'No hay venta abierta que cancelar.' };
    }
    deps.store.cancel(owner);
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

/**
 * Resume entry ([Continuar venta] / NL `continuar`): re-renders the
 * in-progress draft on the same card — re-settle with zero patch, zero
 * mutation. No open draft → clarification, never a fresh draft.
 */
export async function refreshCurrentSale(actor: SaleActor, deps: SaleDeps): Promise<SaleResult> {
  const owner = { chatId: actor.chatId, userId: actor.userId };
  const current = deps.store.get(owner);
  if (current === undefined) {
    const confirmed = deps.store.confirmed(owner);
    if (confirmed !== undefined) {
      return {
        kind: 'already-confirmed',
        draft: confirmed,
        text: renderSaleDraftSummary(confirmed, deps.inventoryRows, deps),
      };
    }
    return { kind: 'clarification', draft: null, text: 'No hay venta abierta que continuar.' };
  }
  deps.store.save(refreshProposal(current, deps));
  const saved = deps.store.get(owner) ?? current;
  return settle(saved, deps);
}
/**
 * Choice entry: the service/modality option buttons
 * ([Netflix · Perfil][FlujoTV · Perfil][FlujoTV · Completa]) fold a
 * structured choice into the SAME open draft (button≡NL with the
 * equivalent NL sentence). No draft → clarification, never a guess.
 */
export async function prepareNewSaleChoice(
  actor: SaleActor,
  choice: { service: import('./newSaleDraft').SaleService; modality: import('./pricePolicy').SaleModality },
  deps: SaleDeps,
): Promise<SaleResult> {
  const owner = { chatId: actor.chatId, userId: actor.userId };
  const current = deps.store.get(owner);
  if (current === undefined) {
    return { kind: 'clarification', draft: null, text: 'No hay borrador de venta abierto.' };
  }
  const { draft } = applySalePatch(current, { service: choice.service, modality: choice.modality });
  deps.store.save(refreshProposal(draft, deps));
  const saved = deps.store.get(owner) ?? draft;
  return settle(saved, deps);
}

/** Re-export for the Slice B wiring (missing-field catalogue in one place). */
export { missingSaleFields };

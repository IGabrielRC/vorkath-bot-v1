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
  type LocationUpdate,
  type NewSaleDraft,
  type NewSaleDraftStore,
  type SalePatch,
} from './newSaleDraft';
import {
  currencyForMethod,
  labelForMethod,
  matchCashHolder,
  parsePaymentMethod,
  resolveCashHolders,
} from './payments';
import { costSnapshotFor, priceSnapshotFor, type SaleModality } from './pricePolicy';
import {
  selectInventory,
  type AccountStatusResolver,
  type InventoryProposal,
} from './inventory';
import {
  missingSaleFields,
  parseSaleExtraction,
  extractNameRemainder,
  extractCustomerLocation,
  buildLocationFromDisplay,
  isLocationLikeFragment,
  isLocationShapedLeftover,
  isNameLikeRemainder,
  subtractConsumedSpans,
  unconsumedTurnFragments,
} from './saleParser';
import type { SaleExtraction } from './saleParser';
import type { CustomerLocation } from '../mock/customers';

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
   * Scoped remainder interpreter (opt-in, at most once per turn — see
   * `ScopedRemainderInterpreter`). Undefined (default) = deterministic
   * only; leftovers fall through to the settle clarification.
   */
  scopedRemainder?: ScopedRemainderInterpreter;
  /**
   * Slice B execution seam (opt-in): when present, `confirm-sale` runs
   * the atomic `confirmNewSale` service against this MockStore.
   * Absent → Slice A refusal (`confirm-refused`, zero side-effects).
   */
  saleExec?: SaleExecDeps;
  /**
   * Safe UX metrics sink (opt-in, HOTFIX 2 Part C): per-operation
   * counters only (turns, parse-vs-Gemini attribution, outcome) — never
   * raw text, phones, or secrets. Undefined = no telemetry.
   */
  metrics?: import('./saleMetrics').SaleMetrics;
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
 * Scoped remainder interpreter (genuinely-ambiguous leftovers ONLY —
 * deterministic first, always). Fires at most once per turn, only when
 * missing fields AND unconsumed current-turn fragments both remain.
 *
 * Contract: `operation` + known safe refs + `missing` + `unconsumed` +
 * `allowed` fields, `currentTurnOnly` (never prior turns, never the
 * global intent, never credentials). Absent (default) → the settle
 * clarification asks instead. Fail-closed application at the call site:
 * deterministic-only fields (service/modality/phone/months/amount)
 * are NEVER accepted from the interpreter.
 */
export interface ScopedRemainderArgs {
  operation: 'NEW_SALE';
  /**
   * Location-only follow-up purpose (Part A): set ONLY on the
   * OPTIONAL_CUSTOMER_LOCATION_EXTRACTION call, which carries
   * `allowed: ['location']` and `missing: []` (location is never a
   * missing field). Never mutates, never touches PAIS_CUENTA.
   */
  purpose?: 'OPTIONAL_CUSTOMER_LOCATION_EXTRACTION';
  /** Safe refs only — no phones-as-secrets, no names beyond the draft. */
  known: {
    service?: string;
    modality?: string;
    months?: number;
    method?: string;
    amount?: number;
    currency?: string;
  };
  missing: string[];
  unconsumed: string[];
  allowed: string[];
  currentTurnOnly: true;
}

export interface ScopedRemainderInterpreter {
  interpretRemainder(args: ScopedRemainderArgs): Promise<{ field: string; value: string } | null>;
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
  | 'pending'
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
  const proposedLocation = draft.customer.proposedCustomer?.location ?? null;
  const pendingLocation = draft.customer.pendingLocation ?? null;
  const locationUpdate = draft.customer.locationUpdate ?? null;
  const input: RenderedNewSaleSummary = {
    customerName: customerDisplayName(draft, { inventoryRows: source }),
    phone: draft.phone ?? '—',
    isNewCustomer: draft.customer.proposedCustomer !== undefined,
    modality: draft.modality ?? '?',
    requestedMonths: draft.duration.requestedMonths ?? 0,
    grantedMonths: granted ?? 0,
    ...(draft.proposal !== null
      ? {
          assignmentModality: draft.modality ?? '?',
          assignmentPerfil: draft.proposal.evidence.perfil,
          assignmentIdentifier: draft.proposal.serviceAccountId.includes(':')
            ? (draft.proposal.serviceAccountId.split(':').slice(1).join(':') ??
              draft.proposal.serviceAccountId)
            : draft.proposal.serviceAccountId,
          emergencyPending: draft.proposal.emergencyRequired && !draft.proposal.emergencyAuthorized,
        }
      : {}),
    // Presentation shows the human location only: the proposed one for
    // new customers, the pending one while the name is still collected,
    // or the explicit update for existing customers. Absent → omitted
    // (capture-if-provided, never asked).
    ...(proposedLocation !== null ? { locationDisplay: proposedLocation.display } : {}),
    ...(proposedLocation === null && pendingLocation !== null
      ? { locationDisplay: pendingLocation.display }
      : {}),
    ...(locationUpdate !== null
      ? {
          locationToDisplay: locationUpdate.to.display,
          ...(locationUpdate.from !== null
            ? { locationFromDisplay: locationUpdate.from.display }
            : {}),
        }
      : {}),
    suggestedAmount: draft.price?.suggestedAmount ?? null,
    ...(draft.price !== null ? { suggestedCurrency: draft.price.currency } : {}),
    actualAmount: draft.payment.actualAmount,
    currency: draft.payment.currency,
    methodLabel: draft.payment.method !== null ? labelForMethod(draft.payment.method) : null,
    receivedBy: draft.payment.receivedBy,
    ...(draft.payment.reference !== undefined ? { reference: draft.payment.reference } : {}),
  };
  return renderNewSaleSummary(input);
}

/**
 * Stored CUSTOMER_LOCATION for the draft's linked existing customer
 * (`null` when the customer has none or the phone is unavailable).
 * Read-only lookup — never PAIS_CUENTA, never a write.
 */
async function storedLocationFor(
  draft: NewSaleDraft,
  deps: SaleDeps,
): Promise<CustomerLocation | null> {
  if (draft.customer.existingCustomerId === undefined || draft.phone === null) {
    return null;
  }
  const customers = await deps.findCustomersByPhone(draft.phone);
  return (
    customers.find((customer) => customer.id === draft.customer.existingCustomerId)?.ubicacion ??
    null
  );
}

/** Normalizes a parsed location into the domain `CustomerLocation`. */
function toCustomerLocation(loc: { raw: string; display: string; city?: string; stateRegion?: string; country?: string }): CustomerLocation {
  return {
    raw: loc.raw,
    display: loc.display,
    ...(loc.city !== undefined ? { city: loc.city } : {}),
    ...(loc.stateRegion !== undefined ? { stateRegion: loc.stateRegion } : {}),
    ...(loc.country !== undefined ? { country: loc.country } : {}),
  };
}

/**
 * Folds one explicit current-turn location into the draft
 * (capture-if-provided, never asked, never blocking):
 * - proposed new customer → `proposedCustomer.location` (clears any
 *   pending hold — the name now owns it);
 * - linked existing customer → `locationUpdate` (keeps the original
 *   `from`, replaces `to` on repeat mentions);
 * - phone known but customer unresolved → `pendingLocation` hold until
 *   the name/selection arrives;
 * - no anchor at all → unchanged (dropped, never asked).
 *
 * Holder collisions (`de Edward`) are ignored: a location that exactly
 * matches a known cash holder is never stored. PAIS_CUENTA is never
 * touched — no code path here references it.
 */
async function attachSaleLocation(
  draft: NewSaleDraft,
  loc: { raw: string; display: string; city?: string; stateRegion?: string; country?: string },
  deps: SaleDeps,
): Promise<NewSaleDraft> {
  const holders = holdersOf(deps);
  if (matchCashHolder(loc.display, holders) !== undefined) {
    return draft;
  }
  const location = toCustomerLocation(loc);
  if (draft.customer.proposedCustomer !== undefined) {
    const { draft: next } = applySalePatch(draft, {
      proposedCustomer: { ...draft.customer.proposedCustomer, location },
      pendingLocation: null,
    });
    return next;
  }
  if (draft.customer.existingCustomerId !== undefined) {
    const from =
      draft.customer.locationUpdate?.existingCustomerId === draft.customer.existingCustomerId
        ? draft.customer.locationUpdate.from
        : await storedLocationFor(draft, deps);
    const { draft: next } = applySalePatch(draft, {
      locationUpdate: { existingCustomerId: draft.customer.existingCustomerId, from, to: location },
      pendingLocation: null,
    });
    return next;
  }
  if (draft.phone !== null) {
    const { draft: next } = applySalePatch(draft, { pendingLocation: location });
    return next;
  }
  return draft;
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
 * Substantive-draft predicate (second-operation guard, single source of
 * truth shared by the webhook text path and the [Venta nueva] button
 * path): a draft carrying ANY business field — service, modality,
 * phone, duration, payment, or customer linkage. An empty just-created
 * shell is NOT substantive: folding a fresh intent into it is the same
 * operation, never a hybrid.
 */
export function isSubstantiveSaleDraft(draft: NewSaleDraft): boolean {
  return (
    draft.service !== null ||
    draft.modality !== null ||
    draft.phone !== null ||
    draft.duration.requestedMonths !== null ||
    draft.payment.method !== null ||
    draft.payment.actualAmount !== null ||
    draft.customer.existingCustomerId !== undefined ||
    draft.customer.proposedCustomer !== undefined
  );
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
    // Phone known, customer not: converge into the recompute → batch
    // path (never a divergent single-question renderer). Name-only
    // remainder → the single name prompt; anything else missing →
    // ONE batched card (name for this number + every other
    // independent field) via expectedSaleFields(). BR-CUS-009,
    // Gabriel Juan class.
    const missing = missingSaleFieldList(draft);
    if (missing.length <= 1) {
      return {
        kind: 'new-customer',
        draft,
        text: renderNewCustomerSalePrompt(draft.phone),
      };
    }
    return {
      kind: 'new-customer',
      draft,
      missing: 'customer',
      missingFields: missing,
      text: renderSaleAskMissingBatch(missing, { customerNameForPhone: draft.phone }),
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
  // Safe UX metrics (counters only — never raw text or secrets): every
  // tool turn counts once as deterministic unless a scoped call fires.
  deps.metrics?.record(base.operationId, 'turn');
  deps.metrics?.record(base.operationId, 'parse_only');
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

  // Pass 1 — deterministic fold (service/modality/months/amount/
  // currency/method/receiver/reference). The customer name is NOT folded
  // here: it resolves in the fixed-point pass below, once dependent
  // state (phone lookup → customerName required) is known.
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

  // Pass 1b — optional CUSTOMER_LOCATION, deterministic evident forms
  // first (HOTFIX 1 open-world, case-insensitive: prepositions, comma
  // pairs anywhere in the turn, and bare singles — `caracas` ≡
  // `Caracas`, `Miami, Florida` mid-sentence included). Evident runs
  // BEFORE the name pass so a captured place never becomes the customer
  // name (`Juan Diaz, Caracas` → name + location); comma-less tails
  // resolve AFTER name consumption (Pass 2b) so a name answer is never
  // stolen as a place. Holder collisions and anchor-less mentions
  // attach nothing (the remainder text is then left intact).
  let remainderText = text;
  const detectedLocation = extractCustomerLocation(text, extraction);
  if (detectedLocation !== undefined) {
    const before = draft;
    draft = await attachSaleLocation(draft, detectedLocation, deps);
    if (draft !== before) {
      remainderText = text.split(detectedLocation.span).join(' ');
    }
  }

  // Pass 2 — fixed-point extraction (root fix for name-before-needed):
  // parse → fold (above) → resolve dependent state (phone lookup makes
  // customerName required) → recompute missing → re-evaluate UNCONSUMED
  // current-turn fragments against the newly-known missing → apply →
  // recompute. The raw turn text + fragments live ONLY in this call
  // (never prior interactions, never persisted). Stops on no-progress |
  // READY | genuine ambiguity; MAX_FIXED_POINT_PASSES bounds it.
  // Zero business mutation: only the in-memory draft is patched —
  // ledger/customer writes happen exclusively at confirm.
  //
  // Receiver comes ONLY from explicit holder evidence (exact identity —
  // `Eduardo` never matches `Edward`; the operator is never defaulted):
  // the recibió-family clause, the resumed bare-holder answer, or an
  // exact holder hiding in the leftovers (`Zelle, Edward` → Edward).
  const consumedFragments: string[] = [];
  if (detectedLocation !== undefined && remainderText !== text) {
    consumedFragments.push(detectedLocation.span);
  }
  if (draft.payment.receivedBy === null) {
    for (const segment of unconsumedTurnFragments(remainderText, extraction)) {
      const hit = matchCashHolder(segment, holders);
      if (hit !== undefined) {
        ({ draft } = applySalePatch(draft, { receivedBy: hit }));
        consumedFragments.push(segment);
        break;
      }
    }
  }
  const MAX_FIXED_POINT_PASSES = 3;
  for (let pass = 0; pass < MAX_FIXED_POINT_PASSES; pass += 1) {
    if (
      draft.customer.existingCustomerId !== undefined ||
      draft.customer.proposedCustomer !== undefined ||
      draft.phone === null
    ) {
      break;
    }
    const remainder = extractNameRemainder(remainderText, extraction, consumedFragments);
    if (remainder === undefined) {
      break;
    }
    // Name-vs-holder collision: an EXACT holder-identity match already
    // resolved to receiver above; it never becomes the customer name
    // (never naive contains() — `Eduardo` never matches `Edward`).
    if (matchCashHolder(remainder, holders) !== undefined) {
      break;
    }
    // A held pending location moves into the proposal with the name —
    // the name now owns it (never duplicated, never asked again).
    ({ draft } = applySalePatch(draft, {
      proposedCustomer: {
        name: remainder,
        phone: draft.phone as string,
        ...(draft.customer.pendingLocation !== undefined
          ? { location: draft.customer.pendingLocation }
          : {}),
      },
    }));
    consumedFragments.push(remainder);
  }

  // Pass 2b — open-world comma-less tails (HOTFIX 1): after consuming
  // intent/service/duration/name/phone/amount/currency/method/receiver,
  // a single-token tail left in the fragments is an optional location
  // candidate (`SMOKE caracas` − name/phone/amount → `caracas`;
  // `caracas`/`CARACAS` ≡ `Caracas` — casing never matters). Comma
  // singles and pairs already resolved in Pass 1b. Deterministic only;
  // the scoped Gemini call (Pass 3b) stays the genuinely-needed
  // fallback. Anchor-required (phone/customer on the draft),
  // holder-safe, zero extra turns, never asked: no confidence →
  // uncaptured, never a question. Name/method/receiver spans already
  // consumed above never re-enter (`Juan Diaz` ≠ location,
  // `Edward` ≠ location).
  {
    const locationAbsent =
      draft.customer.proposedCustomer?.location === undefined &&
      draft.customer.locationUpdate === undefined &&
      draft.customer.pendingLocation === undefined;
    if (locationAbsent) {
      for (const fragment of unconsumedTurnFragments(remainderText, extraction, [], {
        keepInertEdges: true,
      })) {
        const tail = subtractConsumedSpans(fragment, consumedFragments);
        if (tail === '' || tail.split(/\s+/).filter(Boolean).length !== 1) {
          continue;
        }
        if (matchCashHolder(tail, holders) !== undefined) {
          continue;
        }
        const mapped = buildLocationFromDisplay(tail);
        if (mapped === undefined || matchCashHolder(mapped.display, holders) !== undefined) {
          continue;
        }
        const before = draft;
        draft = await attachSaleLocation(draft, mapped, deps);
        if (draft !== before) {
          consumedFragments.push(tail);
          break;
        }
      }
    }
  }

  // Pass 3 — scoped remainder (genuinely-ambiguous leftovers ONLY, at
  // most ONE interpreter call per turn): deterministic extractors +
  // the fixed-point pass ran first; this fires only when missing fields
  // AND unconsumed current-turn fragments both remain. Fail-closed:
  // deterministic-only fields (service/modality/phone/months/amount)
  // are never accepted, receiver/method face their exact native checks,
  // and anything else is ignored (settle asks instead).
  if (deps.scopedRemainder !== undefined) {
    const missingNow = missingSaleFieldList(draft);
    // Genuinely unconsumed: fragments NOT already consumed by the
    // deterministic fold or the fixed-point pass (a resolved `Juan Diaz`
    // never re-enters as ambiguity; inert-by-policy already dropped).
    const consumed = new Set(consumedFragments.map((part) => part.trim()));
    const consumedList = [...consumed];
    const unconsumed = unconsumedTurnFragments(remainderText, extraction).filter(
      (part) =>
        !consumed.has(part.trim()) &&
        !consumedList.some((used) => used !== '' && part.trim().startsWith(`${used} `)),
    );
    if (missingNow.length > 0 && unconsumed.length > 0) {
      const decided = await deps.scopedRemainder.interpretRemainder({
        operation: 'NEW_SALE',
        known: {
          ...(draft.service !== null ? { service: draft.service } : {}),
          ...(draft.modality !== null ? { modality: draft.modality } : {}),
          ...(draft.duration.requestedMonths !== null
            ? { months: draft.duration.requestedMonths }
            : {}),
          ...(draft.payment.method !== null ? { method: draft.payment.method } : {}),
          ...(draft.payment.actualAmount !== null ? { amount: draft.payment.actualAmount } : {}),
          ...(draft.payment.currency !== null ? { currency: draft.payment.currency } : {}),
        },
        missing: missingNow,
        unconsumed,
        allowed: ['customer', 'method', 'receiver', 'reference'],
        currentTurnOnly: true,
      });
      if (decided !== null) {
        deps.metrics?.record(draft.operationId, 'gemini assist');
      }
      if (decided !== null && missingNow.includes(decided.field)) {
        if (
          decided.field === 'customer' &&
          draft.phone !== null &&
          draft.customer.existingCustomerId === undefined &&
          draft.customer.proposedCustomer === undefined &&
          isNameLikeRemainder(decided.value) &&
          matchCashHolder(decided.value, holders) === undefined
        ) {
          ({ draft } = applySalePatch(draft, {
            proposedCustomer: { name: decided.value.trim(), phone: draft.phone },
          }));
        } else if (
          decided.field === 'receiver' &&
          matchCashHolder(decided.value, holders) !== undefined
        ) {
          ({ draft } = applySalePatch(draft, {
            receivedBy: matchCashHolder(decided.value, holders) ?? draft.payment.receivedBy,
          }));
        } else if (
          decided.field === 'method' &&
          parsePaymentMethod(decided.value) !== undefined
        ) {
          ({ draft } = applySalePatch(draft, {
            method: parsePaymentMethod(decided.value) ?? draft.payment.method,
          }));
        } else if (decided.field === 'reference' && decided.value.trim() !== '') {
          ({ draft } = applySalePatch(draft, { reference: decided.value.trim() }));
        }
      }
    }
    // Pass 3b — OPTIONAL_CUSTOMER_LOCATION_EXTRACTION (genuinely-needed
    // ONLY, at most one call): deterministic extraction ran first; this
    // fires only when a customer anchor exists, no location is on the
    // draft yet, and a location-SHAPED leftover remains (capitalized —
    // lowercase noise like `precio` never fires it; exact holder matches
    // never fire it). Multi-word phrases fire ONLY when the customer is
    // already resolved, so a name answer is never stolen as a place.
    // `missing: []` because location is never a missing field; `allowed:
    // ['location']` because NOTHING else may come back. Fail-closed:
    // non-geo values, holder collisions and any other field are
    // ignored (never asked, never blocking). PAIS_CUENTA is never
    // touched — this call has no pais channel at all.
    const locationAbsent =
      draft.customer.proposedCustomer?.location === undefined &&
      draft.customer.locationUpdate === undefined &&
      draft.customer.pendingLocation === undefined;
    const anchorPresent =
      draft.phone !== null ||
      draft.customer.proposedCustomer !== undefined ||
      draft.customer.existingCustomerId !== undefined;
    const customerResolved =
      draft.customer.proposedCustomer?.name !== undefined ||
      draft.customer.existingCustomerId !== undefined;
    if (locationAbsent && anchorPresent) {
      const holderSet = holdersOf(deps);
      const locationLeftovers = unconsumedTurnFragments(
        remainderText,
        extraction,
        consumedFragments,
      ).filter(
        (part) =>
          isLocationShapedLeftover(part) &&
          matchCashHolder(part, holderSet) === undefined &&
          (isLocationLikeFragment(part) || customerResolved),
      );
      if (locationLeftovers.length > 0) {
        const located = await deps.scopedRemainder.interpretRemainder({
          operation: 'NEW_SALE',
          purpose: 'OPTIONAL_CUSTOMER_LOCATION_EXTRACTION',
          known: {
            ...(draft.service !== null ? { service: draft.service } : {}),
            ...(draft.modality !== null ? { modality: draft.modality } : {}),
            ...(draft.duration.requestedMonths !== null
              ? { months: draft.duration.requestedMonths }
              : {}),
            ...(draft.payment.method !== null ? { method: draft.payment.method } : {}),
            ...(draft.payment.actualAmount !== null ? { amount: draft.payment.actualAmount } : {}),
            ...(draft.payment.currency !== null ? { currency: draft.payment.currency } : {}),
          },
          missing: [],
          unconsumed: locationLeftovers,
          allowed: ['location'],
          currentTurnOnly: true,
        });
        if (located !== null) {
          deps.metrics?.record(draft.operationId, 'gemini assist');
        }
        if (located !== null && located.field === 'location') {
          const mapped = buildLocationFromDisplay(located.value);
          if (
            mapped !== undefined &&
            matchCashHolder(mapped.display, holdersOf(deps)) === undefined
          ) {
            draft = await attachSaleLocation(draft, mapped, deps);
          }
        }
      }
    }
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
    // Unknown OR shared phone flows through settle: unknown converges
    // to the name batch (or the single name prompt when nothing else
    // is missing), shared disambiguates — never a divergent renderer.
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
    return settle(current, deps, customers);
  }
  return settle(current, deps);
}

export type SaleAction =
  | { type: 'provide-name'; name: string; location?: CustomerLocation }
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
    // A held pending location converts into the explicit update (same
    // operation, no separate step): `from` reads the stored value.
    const pending = current.customer.pendingLocation;
    let locationUpdate: LocationUpdate | undefined;
    if (pending !== undefined) {
      let from: CustomerLocation | null = null;
      if (current.phone !== null) {
        const candidates = await deps.findCustomersByPhone(current.phone);
        from = candidates.find((candidate) => candidate.id === action.customerId)?.ubicacion ?? null;
      }
      locationUpdate = { existingCustomerId: action.customerId, from, to: pending };
    }
    const { draft } = applySalePatch(current, {
      existingCustomerId: action.customerId,
      ...(locationUpdate !== undefined ? { locationUpdate } : {}),
    });
    deps.store.save(refreshProposal(draft, deps));
    const saved = deps.store.get(owner) ?? draft;
    return settle(saved, deps);
  }
  // Explicit button location wins; otherwise a held pending location
  // moves into the proposal with the name (never asked again). Holder
  // collisions are dropped (never stored as a place).
  const rawButtonLocation = action.location ?? current.customer.pendingLocation;
  const buttonLocation =
    rawButtonLocation !== undefined &&
    matchCashHolder(rawButtonLocation.display, holdersOf(deps)) !== undefined
      ? undefined
      : rawButtonLocation;
  const { draft } = applySalePatch(current, {
    proposedCustomer: {
      name: action.name,
      phone: current.phone ?? '',
      ...(buttonLocation !== undefined ? { location: buttonLocation } : {}),
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

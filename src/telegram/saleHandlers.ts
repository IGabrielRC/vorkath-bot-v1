/**
 * NewSale Telegram helpers (Slice B — single-card UX).
 *
 * Presentation + routing glue ONLY: the domain work lives in
 * `sale/newSaleTool.ts` (draft/proposal/summary) and
 * `sale/newSaleConfirm.ts` (atomic execution). Every callback this
 * module introduces travels owned (interaction id on the button), so
 * the central topic-ownership guard + cross-actor/cross-thread checks
 * in `webhook.ts` apply unchanged. General/Alertas stay
 * non-operational through that same guard.
 *
 * - `isSaleCue`: NL entry cue (`quiero vender`, `venta nueva`,
 *   `vende/vender/vendo…`). Word-boundaried over normalized text so
 *   `vence/vencido/vencimiento/inventario` never match.
 * - `saleTextContinues`: true when the extraction carries at least one
 *   sale field (service/modality/months/amount/method/phone/receiver/
 *   reference/correction) — lets guided replies (phone, months, …) and
 *   corrections continue an open sale draft without stealing unrelated
 *   searches.
 * - `SALE_ENTRY_TEXT`: OPERAR shows only currently-implemented options
 *   (Venta nueva — no Renovación, no full Vencidos/Inventario/Caja,
 *   no Bolsa/Cierre).
 * - `keyboardForSaleResult`: single-card keyboards per result kind —
 *   summary → draftKeyboard (same card, Confirm/Correct/Cancel/Volver);
 *   pending → salePendingKeyboard ([Continuar venta][Cancelar venta]);
 *   emergency-auth → saleEmergency keyboard (explicit auth, never
 *   Confirmar); confirmed → credentialCardKeyboard with the wa.me URL
 *   (Fase 3 EXACTLY); every other incomplete state → the contextual
 *   saleProgressKeyboard (Volver/Cancelar + valid next actions, never
 *   Confirmar).
 */

import type { MockStore } from '../mock/mockStore';
import type { AccountStatusResolver } from '../sale/inventory';
import type { SaleClock } from '../sale/newSaleConfirm';
import { isRenewalText, parseSaleExtraction } from '../sale/saleParser';
import type { SaleResult } from '../sale/newSaleTool';
import {
  credentialCardKeyboard,
  draftKeyboard,
  saleEmergencyKeyboard,
  salePendingKeyboard,
  saleProgressKeyboard,
  type InlineKeyboardMarkup,
} from './keyboards';

export interface SaleWebhookDeps {
  /** Per-operator NewSale drafts (owned by chatId:userId, like DraftEngine). */
  saleDrafts: import('../sale/newSaleDraft').NewSaleDraftStore;
  /** Live MOCK store: inventory rows + atomic sale ledger seam. */
  mockStore: MockStore;
  clock?: SaleClock;
  statusOf?: AccountStatusResolver;
  capacityOverrides?: Record<string, number>;
  cashHolders?: string[];
  /** Technical-failure alerts only (safe summary, never secrets). */
  onAlert?: (alert: { title: string; summary: string }) => void;
}

export const SALE_ENTRY_TEXT =
  '⚡ OPERAR\n\n¿Qué operamos?\n\n🛒 Venta nueva — perfil Netflix o FlujoTV compartida/completa.';

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * NL entry cue for the NewSale flow. Real sale language (semantic,
 * case/accent/typo tolerant over folded text):
 * - classic: `venta(s)`, `vende`, `vender`, `vendo`, `vendemos`;
 * - natural: `dame`/`sácame`/`necesito`/`quiero` + a sale noun
 *   (`cuenta nueva`, `perfil`, `completa`, `netflix`, `flujo`…):
 *   "dame una cuenta nueva netflix", "sácame una netflix",
 *   "necesito una completa de flujo", "dame un perfil flujo por 30 dias".
 *
 * Never matches: `vence`/`vencido`/`vencimiento`/`por vencer`,
 * `inventario`, credential requests (`dame los datos…` — no sale noun),
 * or renewal-reserved words (`recarga`/`renueva` — Fase 5, safe hold
 * reply instead of a draft).
 */
export function isSaleCue(text: string): boolean {
  const n = ` ${fold(text)} `;
  if (isRenewalText(text)) {
    return false;
  }
  if (
    /\bventas?\b/.test(n) ||
    /\bvende\b/.test(n) ||
    /\bvender\b/.test(n) ||
    /\bvendo\b/.test(n) ||
    /\bvendemos\b/.test(n)
  ) {
    return true;
  }
  const hasVerb = /\bdame\b|\bdamela\b|\bsacame\b|\bsaca\b|\bnecesito\b|\bquiero\b/.test(n);
  if (!hasVerb) {
    return false;
  }
  // Credential/delivery requests are never sales ("dame los datos…").
  if (/\bdatos\b|\bcontrasena\b|\bclave\b|\bacceso\b|\bwhatsapp\b|\bwasap\b|\bwatsap\b|\bguasap\b|\bwsp\b|\bmensaje\b/.test(n)) {
    return false;
  }
  return (
    /\bnueva\b|\bnuevo\b|\bcompleta\b|\bcompartida\b|\bperfil\b|\bnetflix\b|\bnetflx\b|\bnetlix\b|\bflujo\b|\bflugo\b|\bcuenta\b/.test(n)
  );
}

/**
 * Fresh NEW_SALE cue while a draft is already in progress: a second
 * operational request (not a correction, not a field answer) that must
 * NEVER open a parallel card. The caller edits the SAME card to the
 * GESTIÓN PENDIENTE notice with [Continuar venta][Cancelar venta].
 */
export function isFreshSaleCue(text: string): boolean {
  return isSaleCue(text);
}

/**
 * Pending-management notice (same-card edit): the operation stays open,
 * the draft stays intact, and the operator resumes or cancels from the
 * SAME card — never a second operational card.
 */
export function renderSalePendingManagement(): string {
  return (
    '⏳ GESTIÓN PENDIENTE\n\nTienes una venta en curso. Termínala o cancélala antes de abrir otra gestión.'
  );
}

/**
 * True when one operator sentence carries at least one sale field, so an
 * open draft keeps consuming guided replies/corrections while unrelated
 * searches (no sale field at all) fall through to the normal cascade.
 * Renewal hints never continue a sale (reserved, safe hold instead).
 */
export function saleTextContinues(text: string): boolean {
  const extraction = parseSaleExtraction(text);
  if (extraction.renewalHint === true) {
    return false;
  }
  return (
    extraction.service !== undefined ||
    extraction.modality !== undefined ||
    extraction.unsupported !== undefined ||
    extraction.months !== undefined ||
    extraction.amount !== undefined ||
    extraction.method !== undefined ||
    extraction.phoneRaw !== undefined ||
    extraction.receiverRaw !== undefined ||
    extraction.referenceRaw !== undefined ||
    extraction.isCorrection
  );
}

/**
 * Single-card keyboard per sale result kind. Confirmar/Corregir appear
 * ONLY on the ready summary; every incomplete state gets the contextual
 * progress keyboard (Volver/Cancelar + valid next actions, never
 * Confirmar). Confirmed cards reuse the Fase 3 credential keyboard
 * EXACTLY (wa.me URL button when prepared); the emergency card never
 * offers Confirmar.
 */
export function keyboardForSaleResult(
  result: SaleResult,
  interactionId: string,
  whatsappUrl?: string,
): InlineKeyboardMarkup {
  switch (result.kind) {
    case 'emergency-auth':
      return saleEmergencyKeyboard(interactionId);
    case 'confirmed':
    case 'already-confirmed':
      return credentialCardKeyboard(interactionId, whatsappUrl, { showServices: false });
    case 'summary':
      return draftKeyboard(interactionId);
    case 'pending':
      return salePendingKeyboard(interactionId);
    default:
      return saleProgressKeyboard(interactionId, result.missing);
  }
}

/**
 * Sale NavStack view per result kind (text-start and callback-start
 * share these semantics — both render through the same sale flows).
 * `sale-entry` is the OPERAR entry card (Volver parent of every sale);
 * `sale-batch` covers ask-missing/new-customer/disambiguate/clarification
 * follow-ups (re-settled on Volver against the intact draft).
 */
export function saleViewForResult(result: SaleResult): string {
  switch (result.kind) {
    case 'summary':
      return 'sale-summary';
    case 'confirmed':
    case 'already-confirmed':
      return 'sale-confirmed';
    case 'emergency-auth':
      return 'sale-emergency';
    case 'no-inventory':
      return 'sale-noinventory';
    case 'pending':
      return 'sale-pending';
    case 'cancelled':
      return 'sale-cancelled';
    default:
      return 'sale-batch';
  }
}

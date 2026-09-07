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
 *   summary/ask/disambiguate/new-customer → draftKeyboard (same card,
 *   Confirm/Correct/Cancel/Volver); emergency-auth → saleEmergency
 *   keyboard (explicit auth, never Confirmar); confirmed →
 *   credentialCardKeyboard with the wa.me URL (Fase 3 EXACTLY).
 */

import type { MockStore } from '../mock/mockStore';
import type { AccountStatusResolver } from '../sale/inventory';
import type { SaleClock } from '../sale/newSaleConfirm';
import { parseSaleExtraction } from '../sale/saleParser';
import type { SaleResult } from '../sale/newSaleTool';
import {
  credentialCardKeyboard,
  draftKeyboard,
  saleEmergencyKeyboard,
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
 * NL entry cue for the NewSale flow. Matches `venta(s)`, `vende`,
 * `vender`, `vendo`, `vendemos` as whole words — never `vence`,
 * `vencido/a(s)`, `vencimiento`, `por vencer`, `inventario`,
 * `disponible`.
 */
export function isSaleCue(text: string): boolean {
  const n = ` ${fold(text)} `;
  return (
    /\bventas?\b/.test(n) ||
    /\bvende\b/.test(n) ||
    /\bvender\b/.test(n) ||
    /\bvendo\b/.test(n) ||
    /\bvendemos\b/.test(n)
  );
}

/**
 * True when one operator sentence carries at least one sale field, so an
 * open draft keeps consuming guided replies/corrections while unrelated
 * searches (no sale field at all) fall through to the normal cascade.
 */
export function saleTextContinues(text: string): boolean {
  const extraction = parseSaleExtraction(text);
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
 * Single-card keyboard per sale result kind. Confirmed cards reuse the
 * Fase 3 credential keyboard EXACTLY (wa.me URL button when prepared);
 * the emergency card never offers Confirmar.
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
    default:
      return draftKeyboard(interactionId);
  }
}

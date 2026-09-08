/**
 * Sale NL extraction — deterministic L2-obvious layer (Slice A).
 *
 * Zero Gemini, zero mutation: turns one operator sentence into a
 * `SaleExtraction` the `prepareNewSale` tool folds into the draft
 * (full-combo extracts everything; partial yields ask-only-missing;
 * corrections patch the SAME draft). Lives OUTSIDE `parser/fast.ts` on
 * purpose: the live L1/L2 cascade pins sell/renew verbs to `none`/
 * UNKNOWN until Slice B wires routing (see `conversationalTwins`
 * contract tests) — this module is the extraction core Slice B will
 * call, already locked by tests here.
 *
 * L3 contract for Slice B (Gemini interprets intent + params ONLY,
 * never executes): params.identifier (phone verbatim), params.service
 * (`netflix`/`flujotv` verbatim), params.modality (`profile`/`shared`/
 * `complete` verbatim), params.months, params.amount + params.currency,
 * params.method, params.receiver (name verbatim), params.correction
 * (true on correction verbs). Absent stays absent.
 */

import { extractPhoneCandidates } from '../parser/fast';
import {
  currencyForMethod,
  detectSplitPayment,
  parsePaymentMethod,
  type PaymentCurrency,
  type PaymentMethod,
} from './payments';
import type { SaleModality } from './pricePolicy';
import type { SaleService } from './newSaleDraft';

export interface SaleExtraction {
  service?: SaleService;
  modality?: SaleModality;
  /** Slice-excluded targets are reported, never coerced (BR-NFX-007). */
  unsupported?: 'netflix-complete';
  /**
   * Renewal-reserved words detected (`recarga`, `renueva`, `renovar`…).
   * When true the sentence is NEVER a NEW_SALE: the caller answers the
   * safe renewal-hold reply instead of folding any field. Renewal stays
   * semantically reserved (no Fase 5 implementation here).
   */
  renewalHint?: boolean;
  months?: number;
  amount?: number;
  amountCurrency?: PaymentCurrency;
  method?: PaymentMethod;
  splitAttempt: boolean;
  /** First phone candidate (`+`-preserving raw), if any. */
  phoneRaw?: string;
  /** Name after recibió-family verbs, if any. */
  receiverRaw?: string;
  /** Optional payment reference (`ref 123`, `referencia: ABC`). */
  referenceRaw?: string;
  isCorrection: boolean;
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const MONTHS_RE = /(\d{1,2})\s*mes(?:es)?\b/i;

/** "30 días/dias" → duration in months (30d ≈ 1 month, rounded, min 1). */
const DAYS_RE = /(\d{1,3})\s*d[ií]as\b/;

/** "por un mes" / "un mes" — word-form single month. */
const ONE_MONTH_RE = /\bun\s+mes\b/;

/**
 * Renewal-reserved words (Fase 5 reserved, NEVER NEW_SALE):
 * `recarga`, `renueva`, `renovar`, `renovación`… — matched over folded
 * text so case/accents never slip through.
 */
const RENEWAL_RE = /\brecarg|\brenuev|\brenov|\brenew/;

const AMOUNT_EXPLICIT_RE = /(\d+(?:[.,]\d{1,2})?)\s*(usd|usdt|\$|dolares?|bs\.?|bolivares?|ves)(?![A-Za-z0-9_])/;

/** Leading-sign form (`$5`, `$ 5`) → USD. Checked after the trailing form. */
const AMOUNT_DOLLAR_PREFIX_RE = /\$\s*(\d+(?:[.,]\d{1,2})?)\b/;

/**
 * Bare amount right after the method word (`zelle 4`, `pago móvil
 * 1800`): the method implies the currency, so no currency token is
 * needed and none is re-asked. Guarded to <7 digits so phone runs
 * (>=7 digits) never become amounts.
 */
const AMOUNT_AFTER_METHOD_RE = /(?:zelle|binance|pago\s*movil|pagomovil|movil|usdt)\s+(\d+(?:[.,]\d{1,2})?)\b/i;

const AMOUNT_CUE_RE =
  /(?:pago|paga|pagaron|monto|recibi[óo]|recibe|cobro|cuesta|precio|son|de)\w*\s+(?:de\s+)?(\d+(?:[.,]\d{1,2})?)\b/;

const RECEIVER_RE =
  /(?:recibi[óo]|recibe|recibido\s+por|lo\s+recibi[óo]|fue|fueron)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+)?)/i;

const REFERENCE_RE = /\bref(?:erencia)?\s*[:#]?\s*([A-Za-z0-9-]{2,32})\b/i;

const CORRECTION_RE = /\bcambi|\bcorrig|\bcorrecci|\bmejor\b|\bhazlo\b|\bponle\b|\bno\s+era\b|\bera\s+de\b/;

function toDraftService(service: SaleService): SaleService {
  return service;
}

function parseAmountNumber(raw: string): number {
  return Number(raw.replace(',', '.'));
}

function currencyFromToken(token: string): PaymentCurrency {
  const t = token.replace(/\./g, '');
  if (t === 'usdt') {
    return 'USDT';
  }
  if (t === 'bs' || t === 'bolivares' || t === 'ves') {
    return 'VES';
  }
  return 'USD';
}

/**
 * True when the sentence carries renewal-reserved words. Exported so the
 * webhook entry cue and the interpreter can reserve the semantics in the
 * same place (single source of truth, never NEW_SALE).
 */
export function isRenewalText(text: string): boolean {
  return RENEWAL_RE.test(fold(text));
}

/**
 * Duration claims its digits before phone-run joining: without this,
 * "04248723454 1 mes" would glue into the phantom phone "042487234541".
 * Spaced single numbers ("414 546 0657", no duration words) still join.
 */
const DURATION_SPAN_RES = [
  /(\d{1,2})\s*mes(?:es)?\b/gi,
  /(\d{1,3})\s*d[ií]as\b/gi,
  /\bun\s+mes\b/gi,
];

function stripDurationSpans(text: string): string {
  let out = text;
  for (const re of DURATION_SPAN_RES) {
    out = out.replace(re, ' ');
  }
  return out;
}

/**
 * Deterministic extraction. Never invents: every field is present only
 * when stated verbatim; numbers <7 digits never become phones (parser
 * guard) and 7+-digit runs never become amounts without a currency
 * token or payment cue.
 *
 * Real sale language (semantic, typo-tolerant over folded text):
 * - "dame/sácame/necesito… cuenta/perfil netflix[ por 30 dias]" →
 *   service + PROFILE modality (Netflix completa is out of scope and
 *   stays `unsupported`, never asked, never coerced).
 * - "dame un perfil flujo[gtv][ por 30 dias]" → FLUJOTV shared.
 * - "cuenta completa [de flujo]" (even with no `flujo` word — only
 *   COMPLETE modality is sold) → FLUJOTV COMPLETE. Bare "completa" can
 *   never mean Netflix (out of scope), so no service question follows.
 * - Renewal words short-circuit everything: renewalHint only, zero
 *   sale fields — the caller answers the safe hold reply.
 */
export function parseSaleExtraction(text: string): SaleExtraction {
  const n = fold(text);
  const extraction: SaleExtraction = { splitAttempt: detectSplitPayment(text), isCorrection: false };

  if (isRenewalText(text)) {
    extraction.renewalHint = true;
    return extraction;
  }

  const hasNetflix = /\bnetflix\b|\bnetflx\b|\bnetlix\b|\bnetflicks?\b/.test(n);
  const hasFlujo = /\bflujo|\bflugo|\bfluho/.test(n);
  const mentionsComplete = /\bcompleta\b|\bexclusiva\b|\bcuenta completa\b|\bfull\b|\bentera\b/.test(n);

  if (hasNetflix && mentionsComplete) {
    extraction.unsupported = 'netflix-complete';
    extraction.service = 'netflix';
  } else if (hasNetflix) {
    extraction.service = toDraftService('netflix');
    extraction.modality = 'netflix-profile';
  } else if (hasFlujo) {
    extraction.service = toDraftService('flujotv');
    if (mentionsComplete) {
      extraction.modality = 'flujotv-complete';
    } else if (/\bcompartida\b|\bperfil\b|\bcuenta\b|\bnueva\b/.test(n)) {
      extraction.modality = 'flujotv-shared';
    }
  } else if (mentionsComplete) {
    // Bare "dame una cuenta completa": only COMPLETE is sold, and
    // Netflix completa is out of scope — FlujoTV complete, never a
    // service question.
    extraction.service = toDraftService('flujotv');
    extraction.modality = 'flujotv-complete';
  }

  const months = MONTHS_RE.exec(text);
  if (months?.[1] !== undefined) {
    const count = Number(months[1]);
    if (Number.isInteger(count) && count >= 1 && count <= 24) {
      extraction.months = count;
    }
  } else {
    const days = DAYS_RE.exec(n);
    if (days?.[1] !== undefined) {
      const count = Math.max(1, Math.round(Number(days[1]) / 30));
      if (Number.isInteger(count) && count >= 1 && count <= 24) {
        extraction.months = count;
      }
    } else if (ONE_MONTH_RE.test(n)) {
      extraction.months = 1;
    }
  }

  const explicit = AMOUNT_EXPLICIT_RE.exec(n);
  if (explicit?.[1] !== undefined && explicit?.[2] !== undefined) {
    extraction.amount = parseAmountNumber(explicit[1]);
    extraction.amountCurrency = currencyFromToken(explicit[2]);
  } else {
    // `$5` / `$ 5`: the sign leads the number (never a phone — amounts
    // stay <7 digits by the parser guard, phones need >=7 digits).
    const prefixed = AMOUNT_DOLLAR_PREFIX_RE.exec(text);
    if (prefixed?.[1] !== undefined) {
      extraction.amount = parseAmountNumber(prefixed[1]);
      extraction.amountCurrency = 'USD';
    } else {
      // `zelle 4` / `pago móvil 1800`: bare amount after the method —
      // the method implies the currency (caller fills it in). Phone
      // runs (>=7 digits) are excluded so numbers stay numbers.
      const afterMethod = AMOUNT_AFTER_METHOD_RE.exec(n);
      if (
        afterMethod?.[1] !== undefined &&
        afterMethod[1].replace(/\D/g, '').length < 7
      ) {
        extraction.amount = parseAmountNumber(afterMethod[1]);
      } else {
        const cued = AMOUNT_CUE_RE.exec(n);
        if (cued?.[1] !== undefined) {
          extraction.amount = parseAmountNumber(cued[1]);
        }
      }
    }
  }

  const method = parsePaymentMethod(text);
  if (method !== undefined) {
    extraction.method = method;
  }

  const candidates = extractPhoneCandidates(stripDurationSpans(text));
  if (candidates[0] !== undefined) {
    extraction.phoneRaw = candidates[0].raw;
  }

  const receiver = RECEIVER_RE.exec(text);
  if (receiver?.[1] !== undefined) {
    extraction.receiverRaw = receiver[1].trim();
  }

  // Case-preserving: references are opaque tokens, never folded.
  const reference = REFERENCE_RE.exec(text);
  if (reference?.[1] !== undefined) {
    extraction.referenceRaw = reference[1];
  }

  extraction.isCorrection = CORRECTION_RE.test(n);
  return extraction;
}

export type MissingSaleField =
  | 'service'
  | 'modality'
  | 'customer'
  | 'months'
  | 'method'
  | 'amount'
  | 'receiver';

/**
 * Method/currency conflict (never silent conversion): true when the
 * sentence states BOTH a method and an explicit currency that is NOT
 * the method's native currency (e.g. `4 dólares por Binance` states
 * USD against Binance's USDT). The caller asks a minimal
 * clarification and keeps both stated values — it never reinterprets
 * one into the other.
 */
export function isMethodCurrencyConflict(extraction: SaleExtraction): boolean {
  if (extraction.method === undefined || extraction.amountCurrency === undefined) {
    return false;
  }
  return currencyForMethod(extraction.method) !== extraction.amountCurrency;
}

/**
 * Name-like guard for the customer-name remainder (letters/spaces,
 * 2–60 chars, no digits, never a reserved command word). Runs over
 * folded text so case/accents never matter.
 */
export function isNameLikeRemainder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 60) {
    return false;
  }
  if (/\d/.test(trimmed)) {
    return false;
  }
  if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(trimmed)) {
    return false;
  }
  const n = ` ${fold(trimmed)} `;
  if (
    /\b(volver|atras|back|cancel|confirm|continuar|seguir|venta|vende|vender|vendo|datos|whatsapp|wasap|watsap|guasap|wsp|mensaje|inventario|caja|buscar|operar|tasa|precio|codigo|recarg|renuev|renov|zelle|binance|movil|pagomovil|pago|dolar|usdt|usd|ves|bs|bolivar|mes|dias|recibi|recibe|recibio|recibido|recibir)\b/.test(
      n,
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Location-inert tokens (domain rule: the current sale model has NO
 * customerLocation requirement — PAIS_CUENTA belongs to credentials,
 * never to NEW_SALE). These fragments stay unused: stripped from
 * remainder edges, never filling fields, never blocking, never
 * persisting. Extend ONLY via an approved domain rule — never by
 * guessing cities.
 */
const LOCATION_INERT_TOKENS: ReadonlySet<string> = new Set(['caracas']);

function dropInertEdges(tokens: string[]): string[] {
  let start = 0;
  let end = tokens.length;
  while (start < end && LOCATION_INERT_TOKENS.has(fold(tokens[start] ?? ''))) {
    start += 1;
  }
  while (end > start && LOCATION_INERT_TOKENS.has(fold(tokens[end - 1] ?? ''))) {
    end -= 1;
  }
  return tokens.slice(start, end);
}

/**
 * UNCONSUMED current-turn fragments (transient, never persisted): the
 * raw turn text minus everything the deterministic extractors already
 * claimed (receiver clause, phones, reference, amount/currency, method
 * words, service/modality/duration tokens, sale verbs, payment fillers,
 * politeness fillers, location-inert edges). Comma-separated segments;
 * name filtering happens in `extractNameRemainder`, NOT here — this is
 * also the `unconsumed` contract for the scoped remainder interpreter
 * (genuinely-ambiguous leftovers only; inert-by-policy counts as
 * consumed, never as ambiguity).
 */
export function unconsumedTurnFragments(text: string, _extraction: SaleExtraction): string[] {
  let rest = ` ${text} `;
  const receiverMatch = RECEIVER_RE.exec(text);
  if (receiverMatch?.[0] !== undefined) {
    rest = rest.replace(receiverMatch[0], ' ');
  }
  for (const candidate of extractPhoneCandidates(text)) {
    rest = rest.split(candidate.raw).join(' ');
    rest = rest.split(candidate.digits).join(' ');
  }
  const referenceMatch = REFERENCE_RE.exec(text);
  if (referenceMatch?.[0] !== undefined) {
    rest = rest.replace(referenceMatch[0], ' ');
  }
  // Amount + currency tokens (trailing `4 dólares`/`4$` and leading `$5`
  // forms). The currency lookahead (not `\b`) mirrors
  // AMOUNT_EXPLICIT_RE: `\b` can never follow a trailing `$`.
  rest = rest.replace(/\d+(?:[.,]\d{1,2})?\s*(usd|usdt|\$|dolares?|bs\.?|bolivares?|ves)(?![A-Za-z0-9_])/gi, ' ');
  rest = rest.replace(/\$\s*\d+(?:[.,]\d{1,2})?\b/g, ' ');
  rest = rest.replace(
    /\b(pago\s*movil|pagomovil|movil|zelle|binance|usdt|usd|ves|bs\.?|bolivares?|dolares?)\b/gi,
    ' ',
  );
  rest = rest.replace(
    /\b(netflix|netflx|netlix|flujo|flugo|fluho|perfil|compartida|completa|exclusiva|cuenta|nueva|nuevo|vende|vender|vendo|vendemos|dame|damela|sacame|saca|necesito|quiero|para|por|pag[oó]|paga|pagaron|pago|monto|recibi[oó]|recibe|recibido|recibio|lo|fue|fueron|de|del|el|la|los|las|en|un|una|unos|con|al|a|y|e|dame|favor|gracias|urgente|mes(?:es)?|d[ií]as)\b/gi,
    ' ',
  );
  rest = rest.replace(/\d+/g, ' ');
  return rest
    .split(/[,;|\n]+/)
    .map((part) => part.replace(/^[.\s:—-]+|[.\s:—-]+$/g, '').trim())
    .filter((part) => part.length > 0)
    .map((part) => dropInertEdges(part.split(/\s+/).filter(Boolean)).join(' '))
    .filter((part) => part.length > 0);
}

/**
 * Customer-name remainder scoped to the draft: the leading two-word
 * unit of each unconsumed segment, when name-like. Trailing noise stays
 * inert (`Juan Diaz caracas` → `Juan Diaz`; a lone `caracas` → unused).
 * Comma-separated answers (`Zelle, 4 dólares, lo recibió Edward`)
 * collapse to nothing when no name was stated; `Gabriel Juan lo recibió
 * Edward` yields `Gabriel Juan`. Never a naive `contains()`: holder
 * matching stays exact (case-insensitive) at the call site.
 *
 * Trade-off (documented): 3+-word names keep their first two words
 * (`Juan Carlos Pérez` → `Juan Carlos`) — location-noise stripping wins
 * over full-length names per the no-location-field domain rule.
 */
export function extractNameRemainder(text: string, extraction: SaleExtraction): string | undefined {
  const names: string[] = [];
  for (const segment of unconsumedTurnFragments(text, extraction)) {
    const candidate = segment.split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
    if (candidate.length > 0 && isNameLikeRemainder(candidate)) {
      names.push(candidate);
    }
  }
  if (names.length === 0) {
    return undefined;
  }
  names.sort((a, b) => b.length - a.length);
  return names[0];
}

/**
 * Ask-only-missing order (BR-SAL-003, BR-UX-001): service → modality →
 * customer/phone → months → method → amount → receiver. Fields already
 * on the draft never re-ask. `unsupported` short-circuits everything:
 * the caller reports instead of asking.
 */
export function missingSaleFields(extraction: SaleExtraction): MissingSaleField[] | { unsupported: 'netflix-complete' } {
  if (extraction.unsupported !== undefined) {
    return { unsupported: extraction.unsupported };
  }
  const missing: MissingSaleField[] = [];
  if (extraction.service === undefined) {
    missing.push('service');
  }
  if (extraction.modality === undefined) {
    missing.push('modality');
  }
  if (extraction.phoneRaw === undefined) {
    missing.push('customer');
  }
  if (extraction.months === undefined) {
    missing.push('months');
  }
  if (extraction.method === undefined) {
    missing.push('method');
  }
  if (extraction.amount === undefined) {
    missing.push('amount');
  }
  if (extraction.receiverRaw === undefined) {
    missing.push('receiver');
  }
  return missing;
}

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
  /(?:recibi[óo]|recibe|recibido\s+por|lo\s+recibi[óo]|fue|fueron)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+(?!de\b|del\b|en\b|para\b|por\b|con\b)[A-Za-zÁÉÍÓÚÑáéíóúñ]+)?)/i;

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
    // A trailing location preposition belongs to the place, never to
    // the holder (`lo recibió Edward de Caracas` → receiver `Edward`,
    // `Caracas` stays for the location pass).
    const name = receiver[1]
      .trim()
      .replace(/\s+(de|del|en|para|por|con)\s*$/i, '')
      .trim();
    if (name !== '') {
      extraction.receiverRaw = name;
    }
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
 * Location-inert tokens (domain rule, NARROWED by Part A): lowercase or
 * unanchored city noise stays unused — stripped from remainder edges,
 * never filling fields, never blocking, never persisting. CAPITALIZED
 * evident forms (`Caracas`, `de Caracas`, `vive en Caracas`,
 * `Valencia, Carabobo`…) are captured by `extractCustomerLocation`
 * instead (capture-if-provided, never asked). Extend ONLY via an
 * approved domain rule — never by guessing cities.
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
 *
 * `excludedSpans` (optional, additive): verbatim spans already claimed
 * by the location extractor — dropped here so a captured `Caracas`
 * never re-enters as name ambiguity. Compared folded.
 */
export function unconsumedTurnFragments(
  text: string,
  _extraction: SaleExtraction,
  excludedSpans: string[] = [],
): string[] {
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
  const excluded = new Set(excludedSpans.map((span) => fold(span)));
  return rest
    .split(/[,;|\n]+/)
    .map((part) => part.replace(/^[.\s:—-]+|[.\s:—-]+$/g, '').trim())
    .filter((part) => part.length > 0)
    .map((part) => dropInertEdges(part.split(/\s+/).filter(Boolean)).join(' '))
    .filter((part) => part.length > 0)
    .filter((part) => !excluded.has(fold(part)));
}

/**
 * Customer-name remainder scoped to the draft: the leading two-word
 * unit of each unconsumed segment, when name-like. Lowercase trailing
 * noise stays inert (`Juan Diaz caracas` → `Juan Diaz`; a lone
 * `caracas` → unused). CAPITALIZED evident locations (`Juan Diaz,
 * Caracas`) are claimed by `extractCustomerLocation` BEFORE this runs
 * (the caller strips the location span from the text first), so they
 * never reach this function. Comma-separated answers (`Zelle,
 * 4 dólares, lo recibió Edward`) collapse to nothing when no name was
 * stated; `Gabriel Juan lo recibió Edward` yields `Gabriel Juan`.
 * Never a naive `contains()`: holder matching stays exact
 * (case-insensitive) at the call site.
 *
 * Trade-off (documented): 3+-word names keep their first two words
 * (`Juan Carlos Pérez` → `Juan Carlos`); single-word fragments inside
 * payment-context turns read as places (see `extractCustomerLocation`
 * L4 — `Caracas, Zelle, 4 dólares, Edward` → location, never name).
 */
export function extractNameRemainder(
  text: string,
  extraction: SaleExtraction,
  excludedSpans: string[] = [],
): string | undefined {
  const names: string[] = [];
  for (const segment of unconsumedTurnFragments(text, extraction, excludedSpans)) {
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
 * Optional CUSTOMER_LOCATION extraction — deterministic, evident forms
 * first (Part A: capture-if-provided, NEVER asked, never blocking).
 *
 * Capture order (first hit wins, caller strips `span` before the name
 * pass so places never become names):
 * - L1 strong prepositions (`vive en`, `reside en`, `radicado en`,
 *   `ubicado en`, `está en`, `soy de`, `es de`, `desde`): the value is
 *   always a place (single token, `Ciudad, Región` pair, or a
 *   multi-word place like `San Juan de los Morros`).
 * - L2 weak preposition + pair (`de Valencia, Carabobo`).
 * - L3 bare pair with a single-token left side (`Valencia, Carabobo`,
 *   `Miami, Florida`, `Bogotá, Colombia`). A two-word left side
 *   (`Juan Diaz, Caracas`) is NOT a pair — the right side falls to L5.
 * - L4 weak preposition + single token (`de Caracas`, `en Caracas`).
 * - L5 single capitalized token (`Caracas`, `Chile`): a one-word
 *   comma segment that is location-like. The caller gates this on
 *   anchor context (phone/method/amount/receiver in the turn or a
 *   customer already on the draft) — a bare `Caracas` answering the
 *   name question stays a NAME.
 *
 * Conservative by construction (never hallucinated hierarchy):
 * - A single token sets ONLY `city` (`Caracas` never implies a
 *   country).
 * - A pair sets `city` + (`country` when the right side names a known
 *   country, else `stateRegion`). `KNOWN_COUNTRIES` is a display-mapping
 *   aid ONLY — capture never depends on it (no whitelist).
 * - Values must start uppercase in the ORIGINAL text: lowercase noise
 *   (`caracas`) stays inert (the T7/T9 contract holds).
 * - Service words (`Netflix`), sale/payment words and digits are never
 *   places. Cash-holder collisions (`de Edward`) are dropped by the
 *   caller (it owns the holder set) — never here.
 *
 * Trade-off (documented): inside payment-context turns a one-word
 * fragment reads as a place even if it could be a first name (`Ana,
 * Zelle, 4 dólares, Edward` → location Ana). Two-word names are never
 * affected (`Juan Pérez, Zelle, …` → name). PAIS_CUENTA is never
 * touched: this function has no pais parameter, no pais return, and no
 * caller may map its output into a pais field.
 */
export interface ParsedCustomerLocation {
  /** Verbatim as stated (`de Caracas`, `Valencia, Carabobo`). */
  raw: string;
  /** Cleaned human display (`Caracas`, `Valencia, Carabobo`). */
  display: string;
  city?: string;
  stateRegion?: string;
  country?: string;
  /** Exact span the caller strips before the name pass. */
  span: string;
}

/** Display-mapping aid ONLY (pair right-side → country vs region). */
const KNOWN_COUNTRIES: ReadonlySet<string> = new Set(
  [
    'venezuela',
    'colombia',
    'chile',
    'argentina',
    'peru',
    'ecuador',
    'mexico',
    'brasil',
    'espana',
    'panama',
    'republica dominicana',
    'dominicana',
    'estados unidos',
    'usa',
    'eeuu',
    'uruguay',
    'paraguay',
    'bolivia',
    'costa rica',
    'portugal',
    'italia',
    'francia',
    'alemania',
    'canada',
  ].map((entry) => entry),
);

/** Words that can never be (part of) a place value. */
const LOCATION_BLOCKED_FOLDED: ReadonlySet<string> = new Set([
  'netflix',
  'netflx',
  'netlix',
  'flujo',
  'flugo',
  'fluho',
  'perfil',
  'compartida',
  'completa',
  'exclusiva',
  'cuenta',
  'nueva',
  'nuevo',
  'zelle',
  'binance',
  'movil',
  'pagomovil',
  'pago',
  'dolar',
  'dolares',
  'usdt',
  'usd',
  'ves',
  'bs',
  'bolivar',
  'bolivares',
  'mes',
  'meses',
  'dias',
  'recibi',
  'recibe',
  'recibio',
  'recibido',
  'recibir',
]);

const GEO_WORD_RE = /^[A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ.\-]*$/;
const GEO_CONNECTOR_RE = /^(de|del|la|el|los|las|y)$/;

function isGeoPart(value: string, maxWords: number): boolean {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > maxWords) {
    return false;
  }
  const first = words[0];
  if (first === undefined || !GEO_WORD_RE.test(first)) {
    return false;
  }
  // Uppercase start REQUIRED in the original text (lowercase noise
  // stays inert).
  if (first[0] !== first[0]?.toUpperCase()) {
    return false;
  }
  for (const word of words) {
    if (GEO_CONNECTOR_RE.test(fold(word))) {
      continue;
    }
    if (!GEO_WORD_RE.test(word)) {
      return false;
    }
    if (LOCATION_BLOCKED_FOLDED.has(fold(word))) {
      return false;
    }
  }
  return true;
}

/** Comma-cleaned working text (commas preserved for pair detection). */
function stripForLocation(text: string): string {
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
  rest = rest.replace(/\d+(?:[.,]\d{1,2})?\s*(usd|usdt|\$|dolares?|bs\.?|bolivares?|ves)(?![A-Za-z0-9_])/gi, ' ');
  rest = rest.replace(/\$\s*\d+(?:[.,]\d{1,2})?\b/g, ' ');
  rest = rest.replace(
    /\b(pago\s*movil|pagomovil|movil|zelle|binance|usdt|usd|ves|bs\.?|bolivares?|dolares?)\b/gi,
    ' ',
  );
  rest = rest.replace(/\d+/g, ' ');
  return rest;
}

function buildPairLocation(
  raw: string,
  left: string,
  right: string,
  leftMaxWords = 1,
): ParsedCustomerLocation | undefined {
  const city = left.trim();
  const second = right.trim();
  // Both sides single tokens (pairs never swallow names: `Juan Diaz,
  // Caracas` is name + place, never `city: Juan Diaz`). Strong
  // prepositions alone allow a multi-word left side (`vive en San
  // Juan, Puerto Rico`).
  if (!isGeoPart(city, leftMaxWords) || !isGeoPart(second, 1)) {
    return undefined;
  }
  const display = `${city}, ${second}`;
  const base: ParsedCustomerLocation = { raw: raw.trim(), display, city, span: raw.trim() };
  if (KNOWN_COUNTRIES.has(fold(second))) {
    return { ...base, country: second };
  }
  return { ...base, stateRegion: second };
}

function buildSingleLocation(raw: string, value: string, maxWords: number): ParsedCustomerLocation | undefined {
  const display = value.trim();
  if (!isGeoPart(display, maxWords)) {
    return undefined;
  }
  const single = display.split(/\s+/).filter(Boolean).length === 1;
  const location: ParsedCustomerLocation = { raw: raw.trim(), display, span: raw.trim() };
  if (single) {
    // Single tokens assert ONLY the city — never a country (Caracas
    // alone implies nothing beyond itself).
    return { ...location, city: display };
  }
  return location;
}

const PREP_STRONG =
  'vive\\s+en|vivo\\s+en|reside\\s+en|radicad[oa]\\s+en|ubicad[oa]\\s+en|est[aá]\\s+en|soy\\s+de|es\\s+de|desde';
const GEO_ONE = '[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.\\-]*';
const GEO_WORD = `(?:${GEO_ONE}|de|del|la|el|los|las|y)`;
const PAIR_END = '(?=\\s*[,;]|\\s*$)';
/** L1a: strong prep + pair (`vive en Bogotá, Colombia`; right side ALWAYS single). */
const STRONG_PREP_PAIR_RE = new RegExp(
  `\\b(${PREP_STRONG})\\s+(${GEO_ONE}(?:\\s+${GEO_WORD}){0,4})\\s*,\\s*(${GEO_ONE})${PAIR_END}`,
);
/** L1b: strong prep + place without comma (`vive en Caracas`, `reside en San Juan de los Morros`). */
const STRONG_PREP_SINGLE_RE = new RegExp(
  `\\b(${PREP_STRONG})\\s+(${GEO_ONE}(?:\\s+${GEO_WORD}){0,4})${PAIR_END}`,
);
/** L2: weak prep + single-single pair (`de Valencia, Carabobo` — never `de Caracas, Juan Diaz`). */
const WEAK_PREP_PAIR_RE = new RegExp(`\\b(de|en)\\s+(${GEO_ONE})\\s*,\\s*(${GEO_ONE})${PAIR_END}`);
/** L3: bare single-single pair (`Miami, Florida` — never `Juan Diaz, Caracas`). */
const BARE_PAIR_RE = new RegExp(`(^|[,;])\\s*(${GEO_ONE})\\s*,\\s*(${GEO_ONE})${PAIR_END}`, 'g');
/** L4: weak prep + single token (`de Caracas`). */
const WEAK_PREP_SINGLE_RE = new RegExp(`\\b(de|en)\\s+(${GEO_ONE})${PAIR_END}`);

export function extractCustomerLocation(
  text: string,
  _extraction: SaleExtraction,
): ParsedCustomerLocation | undefined {
  const clean = stripForLocation(text);
  // L1a: strong preposition + pair (multi-word left allowed ONLY here).
  const strongPair = STRONG_PREP_PAIR_RE.exec(clean);
  if (strongPair?.[0] !== undefined && strongPair?.[2] !== undefined && strongPair?.[3] !== undefined) {
    const pair = buildPairLocation(strongPair[0], strongPair[2], strongPair[3], 5);
    if (pair !== undefined) {
      return pair;
    }
  }
  // L1b: strong preposition + comma-less place.
  const strong = STRONG_PREP_SINGLE_RE.exec(clean);
  if (strong?.[0] !== undefined && strong?.[2] !== undefined) {
    const single = buildSingleLocation(strong[0], strong[2], 5);
    if (single !== undefined) {
      return single;
    }
  }
  // L2: weak preposition + pair (`de Valencia, Carabobo`).
  const weakPair = WEAK_PREP_PAIR_RE.exec(clean);
  if (weakPair?.[0] !== undefined && weakPair?.[2] !== undefined && weakPair?.[3] !== undefined) {
    const pair = buildPairLocation(weakPair[0], weakPair[2], weakPair[3]);
    if (pair !== undefined) {
      return pair;
    }
  }
  // L3: bare pair with single-token sides (`Miami, Florida` —
  // never `Juan Diaz, Caracas`, whose left side is a name).
  for (const match of clean.matchAll(BARE_PAIR_RE)) {
    const left = match[2] ?? '';
    const right = match[3] ?? '';
    if (left.split(/\s+/).filter(Boolean).length !== 1) {
      continue;
    }
    const pair = buildPairLocation(`${left}, ${right}`, left, right);
    if (pair !== undefined) {
      return pair;
    }
  }
  // L4: weak preposition + single token (`de Caracas`).
  const weakSingle = WEAK_PREP_SINGLE_RE.exec(clean);
  if (weakSingle?.[0] !== undefined && weakSingle?.[2] !== undefined) {
    const single = buildSingleLocation(weakSingle[0], weakSingle[2], 1);
    if (single !== undefined) {
      return single;
    }
  }
  // L5: single capitalized token among the comma segments (`Caracas`
  // in `Caracas, Zelle, 4 dólares, Edward` — method/amount/receiver
  // already stripped above, so only true leftovers are scanned).
  for (const segment of clean
    .split(/[,;|\n]+/)
    .map((part) => part.replace(/^[.\s:—-]+|[.\s:—-]+$/g, '').trim())
    .filter((part) => part.length > 0)) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    if (tokens.length !== 1 || tokens[0] === undefined) {
      continue;
    }
    const single = buildSingleLocation(tokens[0], tokens[0], 1);
    if (single !== undefined) {
      return single;
    }
  }
  return undefined;
}

/**
 * True when a fragment is location-shaped (capitalized, geo-like):
 * the gate for the OPTIONAL_CUSTOMER_LOCATION_EXTRACTION scoped call
 * (genuinely-needed only — lowercase noise like `precio` never fires
 * it) and for location-aware sale continuation.
 */
export function isLocationLikeFragment(value: string): boolean {
  const trimmed = value.trim().replace(/^[.\s:—-]+|[.\s:—-]+$/g, '');
  if (trimmed === '' || trimmed.includes(',')) {
    return false;
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length !== 1 || tokens[0] === undefined) {
    return false;
  }
  return isGeoPart(tokens[0], 1);
}

/**
 * True when a leftover fragment is shaped like an unparsed place the
 * deterministic pass could not claim: single capitalized tokens (rare
 * — L5 usually claims them) or multi-word capitalized phrases with
 * only geo connectors (`San Juan de los Morros`). Lowercase noise,
 * digits, sale/service words and holder-like collisions never qualify
 * (the caller additionally drops exact holder matches — it owns the
 * holder set). The caller fires the scoped call for multi-word phrases
 * ONLY when the customer is already resolved, so a name answer can
 * never be stolen as a place.
 */
export function isLocationShapedLeftover(value: string): boolean {
  const trimmed = value.trim().replace(/^[.\s:—-]+|[.\s:—-]+$/g, '');
  if (trimmed === '' || /\d/.test(trimmed)) {
    return false;
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) {
    return false;
  }
  if (tokens.length === 1) {
    return isLocationLikeFragment(trimmed);
  }
  return isGeoPart(trimmed, 5);
}

/**
 * Maps a scoped-interpreter `location` value (or any stated display)
 * into a conservative `CustomerLocation`: pair → city + country/region
 * (country ONLY when asserted), single token → city only, longer geo
 * phrases → display only (never inferred hierarchy). Returns undefined
 * for non-geo values (fail-closed: never invents).
 */
export function buildLocationFromDisplay(
  stated: string,
): import('../mock/customers').CustomerLocation | undefined {
  const display = stated.trim().replace(/^[.\s:—-]+|[.\s:—-]+$/g, '');
  if (display === '') {
    return undefined;
  }
  if (display.includes(',')) {
    const [left = '', right = ''] = display.split(',', 2).map((part) => part.trim());
    if (!isGeoPart(left, 1) || !isGeoPart(right, 3)) {
      return undefined;
    }
    const shown = `${left}, ${right}`;
    if (KNOWN_COUNTRIES.has(fold(right))) {
      return { raw: stated.trim(), display: shown, city: left, country: right };
    }
    return { raw: stated.trim(), display: shown, city: left, stateRegion: right };
  }
  if (!isGeoPart(display, 5)) {
    return undefined;
  }
  if (display.split(/\s+/).filter(Boolean).length === 1) {
    return { raw: stated.trim(), display, city: display };
  }
  return { raw: stated.trim(), display };
}

/**
 * Ask-only-missing order (BR-SAL-003, BR-UX-001): service → modality →
 * customer/phone → months → method → amount → receiver. Fields already
 * on the draft never re-ask. `unsupported` short-circuits everything:
 * the caller reports instead of asking.
 *
 * NOTE: `location` is deliberately ABSENT — CUSTOMER_LOCATION is
 * capture-if-provided, never asked, never blocking, and adds zero
 * turns (Part A).
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

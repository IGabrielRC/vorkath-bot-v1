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
import { detectSplitPayment, parsePaymentMethod, type PaymentCurrency, type PaymentMethod } from './payments';
import type { SaleModality } from './pricePolicy';
import type { SaleService } from './newSaleDraft';

export interface SaleExtraction {
  service?: SaleService;
  modality?: SaleModality;
  /** Slice-excluded targets are reported, never coerced (BR-NFX-007). */
  unsupported?: 'netflix-complete';
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

const MONTHS_RE = /(\d{1,2})\s*mes(?:es)?\b/;

const AMOUNT_EXPLICIT_RE = /(\d+(?:[.,]\d{1,2})?)\s*(usd|usdt|\$|dolares?|bs\.?|bolivares?|ves)\b/;

const AMOUNT_CUE_RE =
  /(?:pago|paga|pagaron|monto|recibi[óo]|recibe|cobro|cuesta|precio|son|de)\w*\s+(?:de\s+)?(\d+(?:[.,]\d{1,2})?)\b/;

const RECEIVER_RE =
  /(?:recibi[óo]|recibe|recibido\s+por|lo\s+recibi[óo])\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+)?)/;

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
 * Deterministic extraction. Never invents: every field is present only
 * when stated verbatim; numbers <7 digits never become phones (parser
 * guard) and 7+-digit runs never become amounts without a currency
 * token or payment cue.
 */
export function parseSaleExtraction(text: string): SaleExtraction {
  const n = fold(text);
  const extraction: SaleExtraction = { splitAttempt: detectSplitPayment(text), isCorrection: false };

  const hasNetflix = /\bnetflix\b/.test(n);
  const hasFlujo = /\bflujo/.test(n);
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
    } else if (/\bcompartida\b|\bperfil\b/.test(n)) {
      extraction.modality = 'flujotv-shared';
    }
  }

  const months = MONTHS_RE.exec(text);
  if (months?.[1] !== undefined) {
    const count = Number(months[1]);
    if (Number.isInteger(count) && count >= 1 && count <= 24) {
      extraction.months = count;
    }
  }

  const explicit = AMOUNT_EXPLICIT_RE.exec(n);
  if (explicit?.[1] !== undefined && explicit?.[2] !== undefined) {
    extraction.amount = parseAmountNumber(explicit[1]);
    extraction.amountCurrency = currencyFromToken(explicit[2]);
  } else {
    const cued = AMOUNT_CUE_RE.exec(n);
    if (cued?.[1] !== undefined) {
      extraction.amount = parseAmountNumber(cued[1]);
    }
  }

  const method = parsePaymentMethod(text);
  if (method !== undefined) {
    extraction.method = method;
  }

  const candidates = extractPhoneCandidates(text);
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

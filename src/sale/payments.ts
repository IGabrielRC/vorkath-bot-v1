/**
 * Payment method catalog + cash-holder policy (Slice A — NewSale domain).
 *
 * Catalog (BR-PAY-006, FIN §5.2): Pago Móvil→VES, Zelle→USD, Binance→USDT.
 * Single method per operation: split payments are PENDING DECISION
 * (BR-PAY-008) — an attempted split gets an explicit clarification reply,
 * never an implicit division (FIN §5.3).
 *
 * OPERADOR vs RECIBIDO_POR (BR-PAY-001/002/003, BR-PAY-004/005):
 * - `operator` derives from the authenticated session; never asked when
 *   unequivocal, never stored as the receiver.
 * - `receivedBy` comes ONLY from an explicit message/selection and MUST
 *   be a known cash holder; anything else fails closed (stays unset +
 *   clarification) instead of assuming operator == receiver.
 *
 * Cash holders (domain model `CashHolder`: initially Gabriel or Edward):
 * holders are a CONFIGURED set, never "every Telegram operator". No
 * holder config exists in env/auth today (allowlist holds numeric ids,
 * profiles hold display names), so this module introduces the minimal
 * `CASH_HOLDERS` concept: optional CSV config wins, otherwise the
 * documented Gabriel/Edward pair. Matching is case-insensitive and
 * returns the canonical configured casing.
 */

export type PaymentMethod = 'pago-movil' | 'zelle' | 'binance';

export type PaymentCurrency = 'VES' | 'USD' | 'USDT';

export interface PaymentMethodInfo {
  method: PaymentMethod;
  /** Display label (`Pago Móvil`, `Zelle`, `Binance`). */
  label: string;
  currency: PaymentCurrency;
}

export const PAYMENT_METHODS: PaymentMethodInfo[] = [
  { method: 'pago-movil', label: 'Pago Móvil', currency: 'VES' },
  { method: 'zelle', label: 'Zelle', currency: 'USD' },
  { method: 'binance', label: 'Binance', currency: 'USDT' },
];

export function currencyForMethod(method: PaymentMethod): PaymentCurrency {
  const found = PAYMENT_METHODS.find((entry) => entry.method === method);
  if (found === undefined) {
    throw new Error(`unknown payment method: ${method}`);
  }
  return found.currency;
}

export function labelForMethod(method: PaymentMethod): string {
  const found = PAYMENT_METHODS.find((entry) => entry.method === method);
  if (found === undefined) {
    throw new Error(`unknown payment method: ${method}`);
  }
  return found.label;
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Deterministic method extraction over normalized text. Returns the
 * single method mentioned, or undefined when zero (or ambiguous text
 * that `detectSplitPayment` flags — the caller checks splits first).
 */
export function parsePaymentMethod(text: string): PaymentMethod | undefined {
  const n = fold(text);
  const hits = new Set<PaymentMethod>();
  if (/\bpago\s*movil\b|\bpagomovil\b|\bmovil\b/.test(n)) {
    hits.add('pago-movil');
  }
  if (/\bzelle\b/.test(n)) {
    hits.add('zelle');
  }
  if (/\bbinance\b|\busdt\b/.test(n)) {
    hits.add('binance');
  }
  if (hits.size === 1) {
    const [only] = hits;
    return only;
  }
  return undefined;
}

/**
 * Split-payment attempt detector (BR-PAY-008 pending): two or more
 * distinct methods mentioned, or explicit division words. A hit means
 * the operation keeps a single unset method + clarification reply.
 */
export function detectSplitPayment(text: string): boolean {
  const n = fold(text);
  const methods = new Set<PaymentMethod>();
  if (/\bpago\s*movil\b|\bpagomovil\b|\bmovil\b/.test(n)) {
    methods.add('pago-movil');
  }
  if (/\bzelle\b/.test(n)) {
    methods.add('zelle');
  }
  if (/\bbinance\b|\busdt\b/.test(n)) {
    methods.add('binance');
  }
  if (methods.size >= 2) {
    return true;
  }
  return (
    /\bmitad\b|\bdivid|\bparte\s+y\s+parte\b|\bdos\s+pagos\b|\bsplit\b|\bcombin/.test(n) &&
    methods.size >= 1
  );
}

/** Documented initial holder pair (domain model `CashHolder`). */
export const DEFAULT_CASH_HOLDERS: readonly string[] = ['Gabriel', 'Edward'];

/**
 * Resolves the configured holder set. Optional CSV wins (e.g. env
 * `CASH_HOLDERS="Gabriel,Edward"`); empty/missing falls back to the
 * documented pair. Never derives holders from the operator allowlist —
 * holders ≠ operators by design.
 */
export function resolveCashHolders(configured?: string): string[] {
  if (configured !== undefined && configured.trim() !== '') {
    const parsed = configured
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return [...DEFAULT_CASH_HOLDERS];
}

/**
 * Fail-closed holder check: case-insensitive match against the
 * configured set; returns the canonical configured casing, or undefined
 * when the name is not a known holder (caller asks clarification).
 */
export function matchCashHolder(name: string, holders: string[]): string | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted === '') {
    return undefined;
  }
  return holders.find((holder) => holder.toLowerCase() === wanted);
}

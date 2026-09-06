/**
 * L2 fast parser: deterministic phone/email/command/service detection.
 * Never calls Gemini. Guards phone-vs-months so bare counts like
 * "2" are never mistaken for a phone number (phones need >=7 digits).
 */

export type FastCommand =
  | 'confirmar'
  | 'cancelar'
  | 'volver'
  | 'codigo'
  | 'tasa'
  | 'precio';

export type FastParseResult =
  | { kind: 'command'; command: FastCommand }
  | { kind: 'email'; value: string }
  | { kind: 'phone'; value: string; raw: string }
  | { kind: 'createTest'; months: number }
  | { kind: 'section'; section: FastSection }
  | { kind: 'months'; months: number }
  | { kind: 'service'; value: 'netflix' | 'flujotv' }
  | { kind: 'account'; value: string }
  | { kind: 'none' };

/**
 * Home-section NL twins: every home button (OPERAR/VENCIDOS/INVENTARIO/
 * CAJA/MÁS) has a conversational equivalent resolving here, so the tap
 * and the phrase end in the SAME handler. BUSCAR needs no section value:
 * its NL twin is the identifier search (phone/email/account kinds).
 */
export type FastSection = 'operar' | 'vencidos' | 'inventario' | 'caja' | 'mas' | 'buscar';

/**
 * Normalizes free text for deterministic matching: lowercase + accent
 * folding, so "qué se me venció", "QUE SE ME VENCIO" and "muéstrame"
 * all hit the same patterns. Keyword-ifs are NOT the primary NL
 * mechanism — this only resolves CLEAR section phrases; everything
 * ambiguous falls through to L3 (Gemini semantic interpretation).
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Minimum digit count for a phone match — the phone-vs-months guard. */
export const MIN_PHONE_DIGITS = 7;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
/** "2 meses" / "1 mes" — deterministic month correction without Gemini. */
const MONTHS_RE = /(\d{1,2})\s*mes(?:es)?\b/i;

const COMMAND_PATTERNS: Array<{ command: FastCommand; re: RegExp }> = [
  { command: 'confirmar', re: /\bconfirm(ar|o|ado)?\b/i },
  { command: 'cancelar', re: /\bcancel(ar|o|ado)?\b/i },
  { command: 'volver', re: /\b(volver|atr[aá]s|back)\b/i },
  { command: 'codigo', re: /\bc[oó]digo\b/i },
  { command: 'tasa', re: /\btasa\b/i },
  { command: 'precio', re: /\bprecio\b/i },
];

/** Returns the normalized email (lowercased) or null. */
export function parseEmail(text: string): { kind: 'email'; value: string } | null {
  const match = EMAIL_RE.exec(text);
  if (match === null || match[0] === undefined) {
    return null;
  }
  return { kind: 'email', value: match[0].toLowerCase() };
}

/** Returns digits-only phone when >=7 digits exist, else null. */
export function parsePhone(text: string): { kind: 'phone'; value: string; raw: string } | null {
  const candidates = extractPhoneCandidates(text);
  const first = candidates[0];
  if (first === undefined) {
    return null;
  }
  return { kind: 'phone', value: first.digits, raw: first.raw };
}

/**
 * WhatsApp-paste extraction (PARSER layer only — never Telegram
 * handlers, never external services/APIs).
 *
 * Free text pasted from WhatsApp carries numbers with `+`, spaces,
 * dashes, dots and parens (`+58 414-5460657`, `(0424) 203-9835`,
 * `escríbeme al 414 546 0657 o al 4242039835`). Each run with >=7
 * digits becomes a candidate in typed order: `digits` is the bare
 * digit run, `raw` keeps the explicit `+` when present (plus-first
 * runs only) so the domain layer can give `+CC` absolute priority via
 * libphonenumber metadata instead of VE-defaulting it. The FIRST
 * candidate wins for single-identifier search; stored multi-number
 * cells split on the repository side.
 */
export interface PhoneCandidate {
  /** Bare digits, e.g. `584145460657`. */
  digits: string;
  /** `+`-preserving form, e.g. `+584145460657` (or bare digits). */
  raw: string;
}

const PASTE_CANDIDATE_RE = /\+?[\d][\d\s\-.()]{5,}[\d]/g;

export function extractPhoneCandidates(text: string): PhoneCandidate[] {
  const found: PhoneCandidate[] = [];
  PASTE_CANDIDATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PASTE_CANDIDATE_RE.exec(text)) !== null) {
    const chunk = match[0] ?? '';
    const digits = chunk.replace(/\D/g, '');
    if (digits.length < MIN_PHONE_DIGITS) {
      continue;
    }
    const explicitPlus = chunk.trimStart().startsWith('+');
    const raw = `${explicitPlus ? '+' : ''}${digits}`;
    if (found.some((candidate) => candidate.raw === raw)) {
      continue;
    }
    found.push({ digits, raw });
  }
  return found;
}

/** True when the text carries at least one >=7-digit phone candidate. */
export function containsPhoneCandidate(text: string): boolean {
  return extractPhoneCandidates(text).length > 0;
}

/** Returns month count for "N mes(es)" (anywhere in the text), else null. */
export function parseMonths(text: string): { kind: 'months'; months: number } | null {
  const match = MONTHS_RE.exec(text);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const months = Number(match[1]);
  if (!Number.isInteger(months) || months < 1 || months > 24) {
    return null;
  }
  return { kind: 'months', months };
}

/** Create/demo verbs — "hazlo" is deliberately absent (correction, not creation). */
const CREATE_RE = /\b(crea|crear|prueba|demo|test|opera)\b/i;

/**
 * Complete mutation stated up front ("crea una prueba de 2 meses"):
 * create verb + month count in the same text. Returns null when no
 * months are mentioned so incomplete requests ("crea una prueba") keep
 * falling through to L3, which asks only for the missing months.
 */
export function parseCreateTest(text: string): { kind: 'createTest'; months: number } | null {
  if (!CREATE_RE.test(text)) {
    return null;
  }
  const months = parseMonths(text);
  if (months === null) {
    return null;
  }
  return { kind: 'createTest', months: months.months };
}

/**
 * Home-section recognition over NORMALIZED text (clear phrases only).
 *
 * Priority notes (all locked by tests):
 * - "hay <servicio>" (availability question) is inventario and is
 *   checked BEFORE the `service` kind wins — a bare "netflix" still
 *   searches, but "hay Netflix" asks what is available.
 * - Vencidos cues are SKIPPED when a service token is present, so the
 *   filtered search "busca cuentas NETFLIX vencidas" keeps routing to
 *   the `service` kind (future phases own filtered search).
 * - A bare "vence" NEVER matches (it belongs to conversational
 *   references like "esa misma, revísame cuándo vence", which stay L3).
 * - Generic "buscar …" prose is NOT a section: identifier-less search
 *   requests ("quiero buscar un cliente") keep falling through to L3,
 *   which asks only for the missing identifier.
 * - Dataless re-entry ("buscar otro número", "otra cuenta", "otro
 *   número") IS the `buscar` section: no identifier is stated, so it
 *   opens the SAME guided wizard the BUSCAR button opens (button≡NL).
 *   Identifier-bearing text never matches (it resolves to `phone`/
 *   `email`/`account` earlier in the cascade).
 */
export function parseSection(text: string): { kind: 'section'; section: FastSection } | null {
  const n = normalizeText(text);
  // Availability question beats the bare-service search.
  if (/\bhay\s+(netflix|flujo)/.test(n)) {
    return { kind: 'section', section: 'inventario' };
  }
  const hasService = /\bnetflix\b/.test(n) || /\bflujo/.test(n);
  if (!hasService) {
    if (/\bvencid|\bpor vencer\b|se me venci|vencimiento/.test(n)) {
      return { kind: 'section', section: 'vencidos' };
    }
  }
  if (/\binventario\b|\bdisponible(s)?\b|\bexistencias?\b|\bstock\b/.test(n)) {
    return { kind: 'section', section: 'inventario' };
  }
  if (/\bcaja\b|entro hoy|\bcuadre\b/.test(n)) {
    return { kind: 'section', section: 'caja' };
  }
  if (/que mas puedo hacer|otras opciones|muestrame|que mas hay|\bayuda\b/.test(n)) {
    return { kind: 'section', section: 'mas' };
  }
  if (/\boperar\b|\boperacion(es)?\b/.test(n)) {
    return { kind: 'section', section: 'operar' };
  }
  if (/busca\w*\s+otro|otro\s+numero|otra\s+cuenta/.test(n)) {
    return { kind: 'section', section: 'buscar' };
  }
  return null;
}

/**
 * Sell/renew verbs are CONTRACT-ONLY (future prepareSale/prepareRenewal
 * — tool specs + stubs exist, implementation does not). Until their
 * phase, L2 declines them as `none` so they can never become a search,
 * a draft, or a mutation: L3 maps them to guarded UNKNOWN.
 */
const SELL_RENEW_RE = /(vend|renov)/;

function parseCommand(text: string): { kind: 'command'; command: FastCommand } | null {  for (const { command, re } of COMMAND_PATTERNS) {
    if (re.test(text)) {
      return { kind: 'command', command };
    }
  }
  return null;
}

/**
 * Service-name recognition (Netflix + FlujoTV, case/spacing tolerant).
 * Checked LAST before `none` so more specific kinds always win:
 * "precio netflix" stays a `precio` command, "netflix 414..." stays a
 * phone search, "netflix 2 meses" stays a months correction. A bare
 * "netflix" / "flujotv" / "flujo tv" becomes a deterministic repo search
 * (zero Gemini) instead of falling through to L3 UNKNOWN.
 */
export function parseService(text: string): { kind: 'service'; value: 'netflix' | 'flujotv' } | null {
  if (/\bnetflix\b/i.test(text)) {
    return { kind: 'service', value: 'netflix' };
  }
  if (/\bflujo[\s-]*tv\b/i.test(text)) {
    return { kind: 'service', value: 'flujotv' };
  }
  return null;
}

/**
 * Neutral account-identifier recognition (the FlujoTV root-cause fix).
 *
 * FlujoTV CORREO values are bare usernames WITHOUT '@' (`cmaxnet001`,
 * `maxnet001`, … — zero '@' in the whole FlujoTV sheet), while Netflix
 * CORREO values are real emails. The old cascade only knew `email`
 * (requires '@'), so a FlujoTV username fell through to `none` → L3
 * UNKNOWN and was never searched — even though the store matches CORREO
 * substrings. This kind closes that gap WITHOUT assuming email=Netflix:
 * any single-token identifier (username, account, email without '@')
 * becomes a deterministic repo search, and the returned `servicio` comes
 * from the data row itself.
 *
 * Guarded to avoid stealing conversational text: single token only (no
 * whitespace, so "quiero buscar un cliente" stays `none`), 3–64 chars,
 * identifier charset, and MUST contain a digit (plain words like "hola"
 * or "buscar" keep falling through to L3). Every real FlujoTV username
 * in the fixture contains digits.
 */
export function parseAccountIdentifier(
  text: string,
): { kind: 'account'; value: string } | null {
  const token = text.trim();
  if (token.length < 3 || token.length > 64 || /\s/.test(token)) {
    return null;
  }
  if (!/\d/.test(token)) {
    return null;
  }
  if (!/^[A-Za-z0-9._%+-]+$/.test(token)) {
    return null;
  }
  return { kind: 'account', value: token.toLowerCase() };
}

/**
 * Embedded account-identifier extraction (the "revísame maxnet050"
 * root-cause fix).
 *
 * `parseAccountIdentifier` only matches a bare single token, so a
 * conversational phrase like "revísame una cuenta maxnet050" fell
 * through to `none` → L3, where the identifier was dropped and the bot
 * asked for data the user already gave. This scans multi-word text for
 * the FIRST identifier token anywhere in it:
 * - identifier charset, 3–64 chars after trimming chat punctuation
 *   (`"maxnet050."` / `"¿maxnet050?"` still resolve),
 * - MUST contain a digit (plain words never match),
 * - pure-digit tokens are EXCLUDED (digits belong to the phone path;
 *   short counts like "2" or "123" must never become an account search).
 *
 * Every real fixture username (`maxnet050`, `cmaxnet001`, …) contains
 * digits + letters, so they match; the returned `servicio` always comes
 * from the data row itself, never assumed.
 */
export function extractEmbeddedAccount(text: string): { kind: 'account'; value: string } | null {
  const candidates = text.match(/[A-Za-z0-9._%+-]+/g) ?? [];
  for (const raw of candidates) {
    const token = raw.replace(/^[.,;:!?"'«»¡¿()]+|[.,;:!?"'«»¡¿()]+$/g, '');
    if (token.length < 3 || token.length > 64) {
      continue;
    }
    if (!/\d/.test(token)) {
      continue;
    }
    if (/^\d+$/.test(token)) {
      continue;
    }
    if (!/^[A-Za-z0-9._%+-]+$/.test(token)) {
      continue;
    }
    return { kind: 'account', value: token.toLowerCase() };
  }
  return null;
}

/**
 * Deterministic cascade: command → email → phone → createTest →
 * section → embeddedAccount → months → service → account → none. "none"
 * means the router must fall through to L3 (Gemini intent-only).
 *
 * `createTest` sits BEFORE `months` so "crea una prueba de 2 meses"
 * opens a draft with months=2 instead of hitting the months-correction
 * branch with no draft open; bare corrections ("hazlo 2 meses", no
 * create verb) still fall through to `months`. `section` sits BEFORE
 * identifier extraction so a section phrase ("qué se me venció") never
 * becomes a stray account/phone search, while identifier-bearing text
 * ("revisame maxnet050…") matches no section cue and flows on.
 */
export function parseFast(text: string): FastParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { kind: 'none' };
  }
  if (SELL_RENEW_RE.test(normalizeText(trimmed))) {
    return { kind: 'none' };
  }
  return (
    parseCommand(trimmed) ??
    parseEmail(trimmed) ??
    parsePhone(trimmed) ??
    parseCreateTest(trimmed) ??
    parseSection(trimmed) ??
    extractEmbeddedAccount(trimmed) ??
    parseMonths(trimmed) ??
    parseService(trimmed) ??
    parseAccountIdentifier(trimmed) ?? { kind: 'none' }
  );
}

/**
 * L2 fast parser: deterministic phone/email/command detection.
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
  | { kind: 'phone'; value: string }
  | { kind: 'email'; value: string }
  | { kind: 'months'; months: number }
  | { kind: 'none' };

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
export function parsePhone(text: string): { kind: 'phone'; value: string } | null {
  const digits = text.replace(/\D/g, '');
  if (digits.length < MIN_PHONE_DIGITS) {
    return null;
  }
  return { kind: 'phone', value: digits };
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

function parseCommand(text: string): { kind: 'command'; command: FastCommand } | null {
  for (const { command, re } of COMMAND_PATTERNS) {
    if (re.test(text)) {
      return { kind: 'command', command };
    }
  }
  return null;
}

/**
 * Deterministic cascade: command → email → phone → months → none.
 * "none" means the router must fall through to L3 (Gemini intent-only).
 */
export function parseFast(text: string): FastParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { kind: 'none' };
  }
  return (
    parseCommand(trimmed) ?? parseEmail(trimmed) ?? parsePhone(trimmed) ?? parseMonths(trimmed) ?? {
      kind: 'none',
    }
  );
}

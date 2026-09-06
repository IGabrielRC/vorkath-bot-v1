import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * THE one phone normalizer (domain/search/repository layer — never a
 * Telegram handler).
 *
 * Real bug: the fixture stores bare national numbers (`4145460657`),
 * trunk-prefixed ones (`0424-…`), international forms (`+58 424-…`),
 * foreign numbers (`18174487435` US, `34674003172` ES) and multi-number
 * cells (`4124086018 / 4242039835`). Users type any variant, so every
 * phone search path (button flow, L2 fast parser, L3 NL, repo lookup)
 * converges on `MockStore.search`, which matches through THIS module.
 *
 * Choice: `libphonenumber-js` (Google metadata, no network, battle-tested
 * trunk/country handling) as the canonical core, with a principled
 * digit-suffix fallback for inputs it cannot parse (partial numbers,
 * malformed cells). The fallback compares PURE digit strings — it never
 * hardcodes a country prefix like "strip 58": two keys match when one is
 * a trailing suffix of the other with >=7 shared digits.
 *
 * Source: libphonenumber-js `parsePhoneNumberFromString`
 * (https://github.com/catamphetamine/libphonenumber-js).
 */

/** Digit floor shared by every phone path (mirrors the L2 phone guard). */
export const PHONE_DIGITS_MIN = 7;

/**
 * Default regions tried for numbers WITHOUT an explicit `+` prefix.
 * VE first (the fixture's home numbering plan), then the foreign plans
 * actually observed in the fixture (US `1…`, ES `34…`).
 */
const DEFAULT_REGIONS: CountryCode[] = ['VE', 'US', 'ES'];

/** Splits multi-number cells (`4124086018 / 4242039835`, `a, b`, `a;b`). */
export function splitStoredNumbers(cell: string): string[] {
  return cell
    .split(/[/,;|]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Canonical match keys for one raw input. Returns [] when no run of
 * >=7 digits exists (short counts like "2" are months, never phones).
 *
 * Spaced/dashed input (`0414 546 0657`, `+58 414-5460657`) is tried
 * BOTH as one joined number (separators are dialing formatting, not
 * boundaries) and as individual tokens, so formatting never destroys
 * the match. Keys mix E.164 digits (when metadata parses the number)
 * with the raw digit run (fallback so partial/unparseable input still
 * matches by suffix). Order: E.164 keys first, raw digits last.
 */
export function normalizePhoneKeys(raw: string): string[] {
  const keys: string[] = [];
  const push = (key: string): void => {
    if (key.replace(/\D/g, '').length >= PHONE_DIGITS_MIN && !keys.includes(key)) {
      keys.push(key);
    }
  };
  const parts = raw
    .replace(/[^\d+]/g, ' ')
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const candidates: string[] = [];
  // Joined run: `0414 546 0657` → `04145460657` (E.164 caps at 15 digits,
  // so longer joins are multi-number cells — tokens handle those).
  const joinedDigits = parts.join('').replace(/\+/g, '');
  if (joinedDigits.length >= PHONE_DIGITS_MIN && joinedDigits.length <= 15) {
    const leadingPlus = parts.some((part) => part.startsWith('+'));
    candidates.push(`${leadingPlus ? '+' : ''}${joinedDigits}`);
  }
  candidates.push(...parts);
  for (const token of candidates) {
    const digits = token.replace(/\D/g, '');
    if (digits.length < PHONE_DIGITS_MIN) {
      continue;
    }
    if (token.startsWith('+')) {
      const parsed = parsePhoneNumberFromString(token);
      if (parsed?.isPossible() === true) {
        push(parsed.number.replace(/\D/g, ''));
      }
    } else {
      for (const region of DEFAULT_REGIONS) {
        const parsed = parsePhoneNumberFromString(token, region);
        if (parsed?.isPossible() === true) {
          push(parsed.number.replace(/\D/g, ''));
        }
      }
    }
    // Raw-digit fallback key: keeps unparseable-but-long inputs
    // (partial numbers, odd cells) matchable via suffix overlap.
    push(digits);
  }
  return keys;
}

/**
 * True when any query key equals any stored key, or one is a trailing
 * suffix of the other with >=7 shared digits (covers trunk `0` and
 * country-code differences WITHOUT naming any country: pure digit
 * relation, e.g. `584145460657` ↔ `04245460657` ↔ `4145460657`).
 */
export function phonesMatch(queryKeys: string[], storedKeys: string[]): boolean {
  for (const query of queryKeys) {
    const qd = query.replace(/\D/g, '');
    if (qd.length < PHONE_DIGITS_MIN) {
      continue;
    }
    for (const stored of storedKeys) {
      const sd = stored.replace(/\D/g, '');
      if (sd.length < PHONE_DIGITS_MIN) {
        continue;
      }
      if (qd === sd) {
        return true;
      }
      const overlap = qd.length <= sd.length ? qd : sd;
      const longer = qd.length <= sd.length ? sd : qd;
      if (overlap.length >= PHONE_DIGITS_MIN && longer.endsWith(overlap)) {
        return true;
      }
    }
  }
  return false;
}

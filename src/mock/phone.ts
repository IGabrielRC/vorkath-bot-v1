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
 * trunk/country handling) as the canonical core. Identity is decided by
 * a strict priority — never a global last-N suffix rule, because
 * two DISTINCT numbers can share trailing digits (e.g. `4145460657` vs
 * `4245460657` both end in `4600657` but are different VE lines):
 *
 *   1. E.164 exact — both sides resolve via libphonenumber-js and the
 *      full international digit strings are equal.
 *   2. Country + nationalNumber exact — region/country metadata proves
 *      both sides are the same national number in the same plan.
 *   3. Normalized exact digits — legacy/unparseable input with no
 *      metadata matches only on the identical digit string.
 *
 * Ambiguity is never resolved by picking one row: a fallback comparison
 * that yields several candidates returns ALL of them (the store slices
 * to MAX_SEARCH_RESULTS in stable order — the multi-result path), so
 * the operator disambiguates, never the matcher.
 *
 * Source: libphonenumber-js `parsePhoneNumberFromString`
 * (https://github.com/catamphetamine/libphonenumber-js).
 */

/** Digit floor shared by every phone path (mirrors the L2 phone guard). */
export const PHONE_DIGITS_MIN = 7;

/**
 * Default region for numbers WITHOUT an explicit `+` prefix. The legacy
 * fixture numbers are Venezuelan bare/trunk-prefixed nationals, so VE
 * lets `4242030438` / `04242030438` / `+584242030438` resolve to the same
 * E.164 — but ONLY when libphonenumber-js metadata genuinely says so
 * (`isPossible()` gate below); the region never forces an identity.
 */
export const DEFAULT_PHONE_REGION: CountryCode = 'VE';

/**
 * Further numbering plans actually observed in the fixture (US `1…`,
 * ES `34…`). Tried after the default region; same `isPossible()` gate,
 * so a VE mis-read of a foreign number never becomes a key.
 */
const ADDITIONAL_PHONE_REGIONS: CountryCode[] = ['US', 'ES'];

const PHONE_REGIONS: CountryCode[] = [DEFAULT_PHONE_REGION, ...ADDITIONAL_PHONE_REGIONS];

/** Splits multi-number cells (`4124086018 / 4242039835`, `a, b`, `a;b`). */
export function splitStoredNumbers(cell: string): string[] {
  return cell
    .split(/[/,;|]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** E.164 key (tier 1): bare international digits, e.g. `584145460657`. */
function e164Key(digits: string): string {
  return digits;
}

/** Country-scoped key (tier 2): e.g. `VE:4145460657`. Never bare digits. */
function countryKey(country: string, nationalNumber: string): string {
  return `${country}:${nationalNumber}`;
}

function pushKey(keys: string[], key: string): void {
  if (!keys.includes(key)) {
    keys.push(key);
  }
}

/**
 * Parses ONE digit run through libphonenumber-js and pushes tier-1
 * (E.164) and tier-2 (country:national) keys for every region whose
 * metadata deems the run possible. Returns true when at least one
 * region resolved the run.
 */
function pushParsedKeys(keys: string[], token: string, explicitPlus: boolean): boolean {
  let resolved = false;
  if (explicitPlus) {
    const parsed = parsePhoneNumberFromString(token);
    if (parsed?.isPossible() === true && parsed.country !== undefined) {
      pushKey(keys, e164Key(parsed.number.replace(/\D/g, '')));
      pushKey(keys, countryKey(parsed.country, parsed.nationalNumber));
      resolved = true;
    }
    return resolved;
  }
  for (const region of PHONE_REGIONS) {
    const parsed = parsePhoneNumberFromString(token, region);
    if (parsed?.isPossible() === true && parsed.country !== undefined) {
      pushKey(keys, e164Key(parsed.number.replace(/\D/g, '')));
      pushKey(keys, countryKey(parsed.country, parsed.nationalNumber));
      resolved = true;
    }
  }
  return resolved;
}

/**
 * Canonical match keys for one raw input. Returns [] when no run of
 * >=7 digits exists (short counts like "2" are months, never phones).
 *
 * Spaced/dashed input (`0414 546 0657`, `+58 414-5460657`) is tried as
 * one joined number (separators are dialing formatting, not boundaries)
 * AND as individual tokens (so an identifier embedded in prose still
 * resolves). Tier-1/2 keys come from libphonenumber-js; the tier-3
 * raw-digit key is emitted ONLY for the joined run (the full number as
 * typed) — never for fragments — so a shared 7-digit tail can never
 * become an identity. Order: E.164 keys first, raw digits last.
 */
export function normalizePhoneKeys(raw: string): string[] {
  const keys: string[] = [];
  const parts = raw
    .replace(/[^\d+]/g, ' ')
    .split(/\s+/)
    .filter((part) => part.length > 0);
  // Joined run: `0414 546 0657` → `04145460657` (E.164 caps at 15 digits,
  // so longer joins are multi-number cells — tokens handle those).
  const joinedDigits = parts.join('').replace(/\+/g, '');
  const joinedIndex =
    joinedDigits.length >= PHONE_DIGITS_MIN && joinedDigits.length <= 15 ? 0 : -1;
  const candidates: Array<{ token: string; isJoined: boolean }> = [];
  if (joinedIndex === 0) {
    const leadingPlus = parts.some((part) => part.startsWith('+'));
    candidates.push({ token: `${leadingPlus ? '+' : ''}${joinedDigits}`, isJoined: true });
  }
  for (const part of parts) {
    candidates.push({ token: part, isJoined: false });
  }
  for (const { token, isJoined } of candidates) {
    const digits = token.replace(/\D/g, '');
    if (digits.length < PHONE_DIGITS_MIN) {
      continue;
    }
    pushParsedKeys(keys, token, token.startsWith('+'));
    // Tier-3 fallback: the full number as typed, exact digits only.
    // Fragments never get a raw key (see docstring); overlong runs
    // (>15 digits, jammed multi-number cells) keep theirs — an exact
    // match on 16+ digits cannot false-positive between numbers.
    if (isJoined || digits.length > 15) {
      if (digits.length >= PHONE_DIGITS_MIN) {
        pushKey(keys, digits);
      }
    }
  }
  return keys;
}

/**
 * True when any query key EXACTLY equals any stored key. Tiers collapse
 * into one set intersection on purpose: E.164 digits, `CC:national`
 * pairs and raw digit runs live in disjoint encodings, so equality IS
 * the priority (a shared key means libphonenumber-js or the identical
 * digit string proved sameness). No suffix/containment rule exists here:
 * distinct numbers with overlapping tails never share a key.
 */
export function phonesMatch(queryKeys: string[], storedKeys: string[]): boolean {
  if (queryKeys.length === 0 || storedKeys.length === 0) {
    return false;
  }
  const stored = new Set(storedKeys);
  return queryKeys.some((key) => stored.has(key));
}

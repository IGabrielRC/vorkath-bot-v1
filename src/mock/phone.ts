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
 * Named configurable region for numbers WITHOUT an explicit `+` prefix.
 * Single constant — no region literal is scattered across the codebase;
 * explicit-`+` inputs NEVER touch it (see `identifyPhone`).
 */
export const DEFAULT_LEGACY_PHONE_REGION: CountryCode = 'VE';

/** Backwards-compatible alias (same value, same rule — prefer the new name). */
export const DEFAULT_PHONE_REGION: CountryCode = DEFAULT_LEGACY_PHONE_REGION;

/**
 * Canonical phone identity: WHAT a raw input means as a dialable number.
 *
 * - `raw`: the input as typed (never destroyed).
 * - `e164`: full international digits (e.g. `584145460657`) — present
 *   only when libphonenumber-js metadata genuinely resolved the input.
 * - `countryCallingCode`: numeric calling code (e.g. `58`), same gate.
 * - `nationalNumber`: national significant number (e.g. `4145460657`).
 * - `region`: libphonenumber region of the resolution (e.g. `VE`) —
 *   phone-side metadata ONLY, never a customer location and never
 *   PAIS_CUENTA (see BR-CUS-006 / BR-ACC-003).
 * - `normalizedDigits`: bare digits as typed (fallback tier, exact only).
 *
 * Identity comparison tiers (see `identitiesMatch`):
 *   E.164 → CC+national → exact national with compatible region →
 *   exact normalized digits. NO last-N / endsWith / contains, ever.
 *
 * Future persistence note: real phone tables should keep
 * phoneRaw/phoneE164/countryCallingCode/nationalNumber/region as
 * separate columns (raw never destroyed, E.164 derived, region from
 * metadata — never defaulted onto explicit-+ input).
 */
export interface PhoneIdentity {
  raw: string;
  e164?: string;
  countryCallingCode?: string;
  nationalNumber?: string;
  region?: CountryCode;
  normalizedDigits: string;
}

/**
 * Further numbering plans actually observed in the fixture (US `1…`,
 * ES `34…`). Tried after the default region; same `isPossible()` gate,
 * so a VE mis-read of a foreign number never becomes a key.
 */
const ADDITIONAL_PHONE_REGIONS: CountryCode[] = ['US', 'ES'];

const PHONE_REGIONS: CountryCode[] = [DEFAULT_LEGACY_PHONE_REGION, ...ADDITIONAL_PHONE_REGIONS];

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

interface ParsedIdentity {
  e164: string;
  countryCallingCode: string;
  nationalNumber: string;
  region: CountryCode;
}

function toParsedIdentity(
  parsed: ReturnType<typeof parsePhoneNumberFromString>,
): ParsedIdentity | null {
  if (parsed === undefined) {
    return null;
  }
  if (parsed.isPossible() !== true || parsed.country === undefined) {
    return null;
  }
  const digits = parsed.number.replace(/\D/g, '');
  const national = parsed.nationalNumber;
  if (digits.length === 0 || national.length === 0 || !digits.endsWith(national)) {
    return null;
  }
  return {
    e164: digits,
    countryCallingCode: digits.slice(0, digits.length - national.length),
    nationalNumber: national,
    region: parsed.country,
  };
}

/**
 * Canonical identities for one raw input. AT LEAST one identity is
 * returned for any run of >=7 digits (digits-only fallback); [] only
 * when no such run exists.
 *
 * - Explicit `+CC` has ABSOLUTE priority: parsed with NO default region
 *   (libphonenumber country-from-prefix metadata decides, never
 *   DEFAULT_LEGACY_PHONE_REGION, never a suffix strip). Exactly ONE
 *   identity — the parsed one, or a digits-only fallback when metadata
 *   rejects it (invalid input matches nothing, never crashes).
 * - `+`-less input is interpreted under DEFAULT_LEGACY_PHONE_REGION
 *   plus the observed additional plans; EVERY region whose metadata
 *   deems the run possible contributes a candidate. One candidate =
 *   safely decidable; several = genuine ambiguity the CALLER must
 *   surface (disambiguation), never resolved by picking one here.
 */
export function identifyPhone(raw: string): PhoneIdentity[] {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < PHONE_DIGITS_MIN) {
    return [];
  }
  const explicitPlus = raw.trimStart().startsWith('+');
  if (explicitPlus) {
    const parsed = toParsedIdentity(parsePhoneNumberFromString(raw));
    if (parsed !== null) {
      return [
        {
          raw,
          e164: parsed.e164,
          countryCallingCode: parsed.countryCallingCode,
          nationalNumber: parsed.nationalNumber,
          region: parsed.region,
          normalizedDigits: digits,
        },
      ];
    }
    return [{ raw, normalizedDigits: digits }];
  }
  const candidates: PhoneIdentity[] = [];
  // Legacy `+`-less nationals are interpreted under
  // DEFAULT_LEGACY_PHONE_REGION (single constant above): when VE
  // metadata resolves the run, that IS the identity — a bare 10-digit
  // national is indistinguishable from a foreign national of the same
  // shape without `+`, so the convention (not a guess) decides, and the
  // operator disambiguates with an explicit `+CC` (absolute priority).
  const legacy = toParsedIdentity(parsePhoneNumberFromString(raw, DEFAULT_LEGACY_PHONE_REGION));
  if (legacy !== null) {
    candidates.push({
      raw,
      e164: legacy.e164,
      countryCallingCode: legacy.countryCallingCode,
      nationalNumber: legacy.nationalNumber,
      region: legacy.region,
      normalizedDigits: digits,
    });
    return candidates;
  }
  // No legacy reading: full-international `+`-less input. Every
  // additional plan whose metadata deems the run possible contributes a
  // candidate — one = safely decidable, several = genuine ambiguity the
  // CALLER must surface (disambiguation), never resolved by picking one.
  for (const region of ADDITIONAL_PHONE_REGIONS) {
    const parsed = toParsedIdentity(parsePhoneNumberFromString(raw, region));
    if (parsed === null) {
      continue;
    }
    if (candidates.some((identity) => identity.e164 === parsed.e164)) {
      continue;
    }
    candidates.push({
      raw,
      e164: parsed.e164,
      countryCallingCode: parsed.countryCallingCode,
      nationalNumber: parsed.nationalNumber,
      region: parsed.region,
      normalizedDigits: digits,
    });
  }
  if (candidates.length > 0) {
    return candidates;
  }
  return [{ raw, normalizedDigits: digits }];
}

/**
 * Tiered identity comparison — the object form of the key equality in
 * `phonesMatch`:
 *   1. E.164 exact (both resolved, full international digits equal);
 *   2. CC + nationalNumber exact;
 *   3. exact nationalNumber with a compatible region (equal regions, or
 *      either side region-less);
 *   4. exact normalizedDigits (legacy/unparseable tier).
 * Anything else — including shared trailing digits — is NOT a match.
 */
export function identitiesMatch(a: PhoneIdentity, b: PhoneIdentity): boolean {
  if (a.e164 !== undefined && b.e164 !== undefined && a.e164 === b.e164) {
    return true;
  }
  if (
    a.countryCallingCode !== undefined &&
    b.countryCallingCode !== undefined &&
    a.nationalNumber !== undefined &&
    b.nationalNumber !== undefined &&
    a.countryCallingCode === b.countryCallingCode &&
    a.nationalNumber === b.nationalNumber
  ) {
    return true;
  }
  if (
    a.nationalNumber !== undefined &&
    b.nationalNumber !== undefined &&
    a.nationalNumber === b.nationalNumber &&
    (a.region === undefined || b.region === undefined || a.region === b.region)
  ) {
    return true;
  }
  return a.normalizedDigits === b.normalizedDigits;
}

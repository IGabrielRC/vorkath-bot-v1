import { identitiesMatch, identifyPhone, type PhoneIdentity } from './phone';

/**
 * Netflix profile-PIN rule (deterministic business rule).
 *
 * EVERY Netflix assignment has a profile PIN = the last 4 digits of the
 * phone truly belonging to THAT assignment (country irrelevant:
 * `+58 414-5460657` → `0657`, `+1 612 441 8159` → `8159`, `…0012` →
 * `"0012"` as a 4-char STRING, never a number).
 *
 * This module is the ONE place that derives it: derivation runs on
 * normalized identity digits (`e164` when resolved, else
 * `normalizedDigits`) — never by slicing a visual/display string, never
 * scattered across handlers. No PIN is ever persisted: bundles carry the
 * derived value transiently per request and interaction state keeps safe
 * refs only.
 *
 * Phone choice per assignment (never arbitrary, never stale):
 * - the assignment's own unequivocal phone (exactly ONE usable identity
 *   across its stored numbers) wins;
 * - else the contextual resolution phone (the actor's own searched phone)
 *   wins when usable AND matching one of the assignment's identities;
 * - else there is NO PIN (the caller asks/disambiguates first) — a PIN
 *   is never guessed from a sibling assignment or a peer's context.
 */

const PIN_LENGTH = 4;

/**
 * Derives the profile PIN from ONE resolved phone identity: last 4 of
 * the normalized digits (`e164` when present, else `normalizedDigits`).
 * Returns undefined when fewer than 4 digits exist (never a partial or
 * zero-padded invention). The result is always a 4-char STRING.
 */
export function deriveNetflixProfilePin(identity: PhoneIdentity): string | undefined {
  const digits = (identity.e164 ?? identity.normalizedDigits).replace(/\D/g, '');
  if (digits.length < PIN_LENGTH) {
    return undefined;
  }
  return digits.slice(-PIN_LENGTH);
}

/**
 * The ONE usable identity across a set of stored raw numbers, or
 * undefined when the set is ambiguous (zero or several usable) — the
 * caller must ask/disambiguate instead of picking one.
 */
export function singleUsableIdentity(raws: string[]): PhoneIdentity | undefined {
  const usable: PhoneIdentity[] = [];
  for (const raw of raws) {
    const identities = identifyPhone(raw);
    if (identities.length !== 1) {
      return undefined;
    }
    const only = identities[0];
    if (only === undefined || only.e164 === undefined) {
      return undefined;
    }
    if (!usable.some((seen) => identitiesMatch(seen, only))) {
      usable.push(only);
    }
  }
  return usable.length === 1 ? usable[0] : undefined;
}

/**
 * Resolves the effective Netflix PIN for ONE assignment's stored phones
 * with an optional contextual phone (the actor's own searched number):
 * the contextual phone wins ONLY when usable and matching one of the
 * assignment's own usable identities; else the assignment-unequivocal
 * phone; else undefined (ask/disambiguate — never arbitrary, never
 * stale, never a sibling assignment's digits).
 */
export function resolveNetflixPin(
  bundlePhones: string[],
  preferredRaw?: string,
): string | undefined {
  const own = singleUsableIdentity(bundlePhones);
  if (preferredRaw !== undefined) {
    const preferred = identifyPhone(preferredRaw);
    if (preferred.length === 1) {
      const candidate = preferred[0];
      if (candidate !== undefined && candidate.e164 !== undefined) {
        const bundleUsable = bundlePhones.flatMap((raw) => {
          const identities = identifyPhone(raw);
          return identities.length === 1 &&
            identities[0] !== undefined &&
            identities[0].e164 !== undefined
            ? [identities[0]]
            : [];
        });
        if (bundleUsable.some((identity) => identitiesMatch(identity, candidate))) {
          return deriveNetflixProfilePin(candidate);
        }
      }
    }
  }
  return own === undefined ? undefined : deriveNetflixProfilePin(own);
}

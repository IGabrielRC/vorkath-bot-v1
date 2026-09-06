import { identifyPhone, type PhoneIdentity } from '../mock/phone';

/**
 * Direct WhatsApp link builder (Slice B — wa.me, prefilled, manual send).
 *
 * The operator taps `💬 Abrir WhatsApp` and Telegram opens the chat with
 * the text prefilled; the operator presses send. The bot NEVER claims
 * delivery — UI wording is always `preparado`, never a past-tense claim.
 *
 * Phone rule (slice-A identity, `identifyPhone`):
 * - Explicit `+CC` has absolute priority (libphonenumber metadata, never
 *   the legacy default region).
 * - A `+`-less (legacy) raw is usable ONLY when it resolves to EXACTLY
 *   ONE identity carrying E.164 (`identifyPhone` length 1 + `e164`
 *   present = safely decidable; zero or several = unusable, never
 *   guessed). A national-only raw is NEVER preferred over E.164: URL
 *   digits always come from `e164`, never from `normalizedDigits`.
 * - Unresolvable → NO link (the caller replies
 *   `No puedo determinar un número internacional válido para WhatsApp.`).
 */

export const WHATSAPP_BASE_URL = 'https://wa.me';

/** Text shown when no stored number resolves to a valid E.164. */
export const WHATSAPP_NO_NUMBER_TEXT =
  'No puedo determinar un número internacional válido para WhatsApp.';

/** Phone-choice question: this exact wording, real-number buttons only. */
export const WHATSAPP_ASK_PHONE_TEXT = '¿A cuál número?';

/** Link-ready line appended to the credential card — `preparado`, never a delivery claim. */
export const WHATSAPP_PREPARED_TEXT = '💬 WhatsApp preparado.';

/**
 * The ONE usable identity for a raw stored number, or undefined when
 * the raw is ambiguous/unresolvable (zero or several candidates, or no
 * E.164). Never picks among candidates — ambiguity is the caller's to
 * surface, never this function's to resolve.
 */
export function usableIdentity(raw: string): PhoneIdentity | undefined {
  const identities = identifyPhone(raw);
  if (identities.length !== 1) {
    return undefined;
  }
  const only = identities[0];
  if (only === undefined || only.e164 === undefined) {
    return undefined;
  }
  return only;
}

export type WhatsAppTarget =
  | { kind: 'direct'; identity: PhoneIdentity }
  | { kind: 'ask'; options: Array<{ raw: string; identity: PhoneIdentity }> }
  | { kind: 'none'; others: string[] };

/**
 * Picks the WhatsApp target for a bundle's stored phones:
 * - a usable search-context phone (the actor's own latest phone query)
 *   wins when valid;
 * - a single usable stored number goes direct;
 * - several usable numbers with none selected → `ask` (the caller shows
 *   one real-number button per option);
 * - none usable → `none` (the caller shows NO link; `others` carries the
 *   raw stored numbers so the reply can still name them).
 */
export function resolveWhatsAppTarget(
  phoneRaws: string[],
  preferredRaw?: string,
): WhatsAppTarget {
  if (preferredRaw !== undefined) {
    const preferred = usableIdentity(preferredRaw);
    if (preferred !== undefined) {
      return { kind: 'direct', identity: preferred };
    }
  }
  const usable = phoneRaws.flatMap((raw) => {
    const identity = usableIdentity(raw);
    return identity === undefined ? [] : [{ raw, identity }];
  });
  if (usable.length === 1 && usable[0] !== undefined) {
    return { kind: 'direct', identity: usable[0].identity };
  }
  if (usable.length > 1) {
    return { kind: 'ask', options: usable };
  }
  return { kind: 'none', others: phoneRaws };
}

/**
 * Builds the direct wa.me URL: `https://wa.me/<E164-digits-no-plus>?text=…`.
 * Digits come ONLY from `identity.e164` (fail-closed: throws when absent
 * so a national-only fallback can never become a bad link). The full URL
 * carries credentialed text — it is transient (button only), NEVER
 * logged, NEVER persisted, NEVER sent to Gemini or AlertService.
 */
export function buildWhatsAppUrl(identity: PhoneIdentity, text: string): string {
  if (identity.e164 === undefined || identity.e164 === '') {
    throw new Error('buildWhatsAppUrl requires a resolved E.164 identity');
  }
  const digits = identity.e164.replace(/\D/g, '');
  return `${WHATSAPP_BASE_URL}/${digits}?text=${encodeURIComponent(text)}`;
}

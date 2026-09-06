import type { CredentialBundle } from '../mock/credentials';
import type { MockService } from '../mock/excelLoader';

/**
 * SHOW_CREDENTIALS tool (deterministic, read-only — Slice A).
 *
 * The SAME entry point serves the 🔐 Datos button (L1) and the explicit
 * datos phrases (L2) plus Gemini semantic/reference variants (L3):
 * intent/reference resolution happens BEFORE this tool runs, and this
 * tool only folds an already-resolved candidate list:
 * - single unambiguous bundle → `direct` (render the card immediately);
 * - multiple bundles → `ask` with the minimal real-data options (the bot
 *   renders one owned button per option, never a free-text password dump);
 * - none → `none` (the caller guides back to search).
 *
 * Read-only: no drafts touched, no business state mutated. Gemini NEVER
 * receives credentials — it interprets intent+reference first and this
 * deterministic fetch runs after.
 */

export type CredentialView =
  | { kind: 'direct'; bundle: CredentialBundle }
  | { kind: 'ask'; options: CredentialBundle[] }
  | { kind: 'none' };

/**
 * Folds resolved candidates with an optional service filter ("dame los
 * datos de Netflix" with a single Netflix assignment → direct). The
 * filter comes from the user's own words, never invented.
 */
export function resolveCredentialView(
  bundles: CredentialBundle[],
  serviceFilter?: MockService,
): CredentialView {
  const filtered =
    serviceFilter === undefined
      ? bundles
      : bundles.filter((bundle) => bundle.service === serviceFilter);
  if (filtered.length === 1) {
    const only = filtered[0] as CredentialBundle;
    return { kind: 'direct', bundle: only };
  }
  if (filtered.length > 1) {
    return { kind: 'ask', options: filtered };
  }
  return { kind: 'none' };
}

/**
 * Minimal disambiguation label from real data (`Netflix · 1 PERFIL (2)`).
 * When candidates span several clients (a shared account viewed from the
 * account card), the holding client prefixes the label so options stay
 * unambiguous.
 */
export function credentialOptionLabel(
  bundle: CredentialBundle,
  multiCustomer: boolean,
): string {
  const serviceProfile = `${bundle.serviceLabel} · ${bundle.profile}`;
  if (multiCustomer) {
    return `${bundle.customerName} · ${serviceProfile}`;
  }
  return serviceProfile;
}

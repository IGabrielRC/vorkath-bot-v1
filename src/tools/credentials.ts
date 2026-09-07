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
 * Stable assignment key from real data (service + account + profile +
 * holding client, normalized). Buttons resolve through this key —
 * on-screen numbering is UX only and never used for resolution.
 */
export function credentialAssignmentKey(bundle: CredentialBundle): string {
  return (
    `${bundle.service}:${bundle.accountIdentifier.trim().toLowerCase()}:` +
    `${bundle.profile.trim().toLowerCase()}:${bundle.customerName.trim().toLowerCase()}`
  );
}

/**
 * Maximum identifier characters shown on a button label. Longer
 * identifiers truncate visibly with `…` (controlled, legible) — the
 * credential card and the assignment blocks always keep the FULL
 * identifier; only the button text truncates. Resolution never reads
 * the label (stable `credentialAssignmentKey` in interaction state).
 */
export const BUTTON_IDENTIFIER_LIMIT = 20;

/** Controlled button-text truncation: full value iff short, else `…`-suffixed. */
export function shortButtonIdentifier(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > BUTTON_IDENTIFIER_LIMIT
    ? `${trimmed.slice(0, BUTTON_IDENTIFIER_LIMIT)}…`
    : trimmed;
}

/**
 * Minimal disambiguation label from real data — ALWAYS
 * `Service · Profile · identifier` (e.g. `Netflix · 1 PERFIL (2) ·
 * dasdsadasda@gmail.com`, `FlujoTV · 1 PERFIL · cmaxnet002`). Service/type
 * alone is never enough to recognize an account, so the identifier is
 * unconditional, never collision-gated. When candidates span several
 * clients (a shared account viewed from the account card), the holding
 * client prefixes the label so options stay unambiguous.
 */
export function credentialOptionLabel(
  bundle: CredentialBundle,
  multiCustomer: boolean,
): string {
  const serviceProfile =
    `${bundle.serviceLabel} · ${bundle.profile} · ${shortButtonIdentifier(bundle.accountIdentifier)}`;
  if (multiCustomer) {
    return `${bundle.customerName} · ${serviceProfile}`;
  }
  return serviceProfile;
}

/**
 * One label per bundle, every label carrying its (possibly truncated)
 * account identifier — service/type alone is never enough. NEVER
 * passwords, PINs or phone-derived data — labels are safe by
 * construction.
 */
export function credentialOptionLabels(bundles: CredentialBundle[]): string[] {
  const multiCustomer =
    new Set(bundles.map((bundle) => bundle.customerName.trim().toLowerCase())).size > 1;
  return bundles.map((bundle) => credentialOptionLabel(bundle, multiCustomer));
}

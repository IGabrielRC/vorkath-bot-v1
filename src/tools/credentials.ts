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

/**
 * One label per bundle with collision disambiguation: identical base
 * labels gain a short safe identifier (the holding client when the
 * candidates share one account, else the account identifier truncated
 * to 20 chars) so similar assignments stay distinguishable. NEVER
 * passwords, PINs or phone-derived data — labels are safe by
 * construction.
 */
export function credentialOptionLabels(bundles: CredentialBundle[]): string[] {
  const multiCustomer = new Set(bundles.map((bundle) => bundle.customerName)).size > 1;
  const base = bundles.map((bundle) => credentialOptionLabel(bundle, multiCustomer));
  const shortAccount = (bundle: CredentialBundle): string =>
    bundle.accountIdentifier.length > 20
      ? `${bundle.accountIdentifier.slice(0, 20)}…`
      : bundle.accountIdentifier;
  const count = (labels: string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const label of labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  };
  // Pass 1: same-account collisions gain the holding client.
  const pass1 = bundles.map((bundle, index) => {
    const label = base[index] as string;
    if (!multiCustomer && (count(base).get(label) ?? 0) > 1) {
      return `${label} · ${bundle.customerName}`;
    }
    return label;
  });
  // Pass 2: remaining collisions gain the short account identifier, so
  // same-client/same-profile assignments (e.g. two `FlujoTV · 1 PERFIL`
  // on `cmaxnet002` vs `cmaxnet004`) stay distinguishable.
  const counts1 = count(pass1);
  return bundles.map((bundle, index) => {
    const label = pass1[index] as string;
    if ((counts1.get(label) ?? 0) > 1) {
      return `${label} · ${shortAccount(bundle)}`;
    }
    return label;
  });
}

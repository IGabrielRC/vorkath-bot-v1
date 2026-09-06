import type { CredentialBundle } from '../mock/credentials';
import { formatExpiryLong, renderExpiryGap } from '../telegram/render';

/**
 * Central WhatsApp template renderer (Slice B — direct wa.me link).
 *
 * Copy lives HERE and ONLY here: greeting, tone, emojis and field order
 * are changeable WITHOUT touching business logic (`webhook.ts` calls
 * `renderCredentialWhatsAppText`, never a template body). Swapping the
 * copy object re-renders through the SAME tool path (locked by the
 * copy-swap test).
 *
 * Templates take the CredentialBundle — the ONLY place outside the
 * Telegram card renderer that touches `accountPassword`/`pin` for
 * delivery. No other module may format secrets into WhatsApp text.
 */

/** Stable template ids, selected by bundle shape — never by guess. */
export type WhatsAppTemplateId =
  | 'credentials.netflix'
  | 'credentials.flujotv.shared'
  | 'credentials.flujotv.complete';

/** One template: bundle in, plain-text WhatsApp body out (no HTML). */
export type WhatsAppTemplate = (bundle: CredentialBundle) => string;

function pinLine(bundle: CredentialBundle): string {
  return bundle.pin !== undefined && bundle.pin !== '' ? `\n🔒 PIN: ${bundle.pin}` : '';
}

/**
 * Expiry line, MANDATORY in every credentials template: THIS assignment's
 * `fechaFin` in the central long Spanish format — never another
 * assignment's, never legacy DIAS, never invented. Invalid/unknown
 * expiry renders the explicit gap, never a fake date.
 */
function expiryLine(bundle: CredentialBundle): string {
  const expiry = formatExpiryLong(bundle.fechaFin) ?? renderExpiryGap();
  return `\n📅 Vence: ${expiry}`;
}

function netflixTemplate(bundle: CredentialBundle): string {
  return (
    `¡Hola, ${bundle.customerName}! 👋\n` +
    `Aquí están tus datos de acceso a ${bundle.serviceLabel}:\n\n` +
    `📧 Cuenta: ${bundle.accountIdentifier}\n` +
    `👤 Perfil: ${bundle.profile}` +
    `${expiryLine(bundle)}\n` +
    `🔑 Contraseña: ${bundle.accountPassword}` +
    `${pinLine(bundle)}\n\n` +
    `¡Disfruta! 🍿`
  );
}

function flujotvSharedTemplate(bundle: CredentialBundle): string {
  return (
    `¡Hola, ${bundle.customerName}! 👋\n` +
    `Aquí están tus datos de acceso a ${bundle.serviceLabel}:\n\n` +
    `👤 Usuario: ${bundle.accountIdentifier}\n` +
    `📺 Perfil: ${bundle.profile}` +
    `${expiryLine(bundle)}\n` +
    `🔑 Contraseña: ${bundle.accountPassword}` +
    `${pinLine(bundle)}\n\n` +
    `¡Disfruta! 🍿`
  );
}

function flujotvCompleteTemplate(bundle: CredentialBundle): string {
  return (
    `¡Hola, ${bundle.customerName}! 👋\n` +
    `Aquí están tus datos de acceso a ${bundle.serviceLabel} (cuenta completa):\n\n` +
    `👤 Usuario: ${bundle.accountIdentifier}` +
    `${expiryLine(bundle)}\n` +
    `🔑 Contraseña: ${bundle.accountPassword}` +
    `${pinLine(bundle)}\n\n` +
    `¡Disfruta! 🍿`
  );
}

/** Default copy registry: every id has exactly one template. */
export const defaultWhatsAppTemplates: Record<WhatsAppTemplateId, WhatsAppTemplate> = {
  'credentials.netflix': netflixTemplate,
  'credentials.flujotv.shared': flujotvSharedTemplate,
  'credentials.flujotv.complete': flujotvCompleteTemplate,
};

/**
 * Selects the template id from the bundle's own shape
 * (`accountType`) — FlujoTV keeps its model, Netflix its own.
 */
export function selectWhatsAppTemplate(bundle: CredentialBundle): WhatsAppTemplateId {
  switch (bundle.accountType) {
    case 'netflix-profile':
      return 'credentials.netflix';
    case 'flujotv-complete':
      return 'credentials.flujotv.complete';
    case 'flujotv-shared':
      return 'credentials.flujotv.shared';
  }
}

/**
 * Renders the WhatsApp body for ONE bundle through the central
 * registry. Pass a custom registry ONLY to swap copy (tests, future
 * MessageTemplate versions) — production always uses the default.
 */
export function renderCredentialWhatsAppText(
  bundle: CredentialBundle,
  templates: Record<WhatsAppTemplateId, WhatsAppTemplate> = defaultWhatsAppTemplates,
): string {
  return templates[selectWhatsAppTemplate(bundle)](bundle);
}

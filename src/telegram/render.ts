/**
 * Central Telegram message design system (presentation ONLY).
 *
 * Every user-visible reply is composed here from small primitives so all
 * handlers, tools and cards share ONE visual language and ONE parse_mode.
 * This module owns NO business logic: statuses are DERIVED by callers
 * (`deriveExpiryStatus`), grouping stays in the domain layer, and no
 * function here reads stores, drafts, interactions or Gemini.
 *
 * Visual contract:
 * - `TELEGRAM_PARSE_MODE` is HTML (set centrally in `client.ts`). HTML
 *   needs escaping for only three characters (`&`, `<`, `>`), while
 *   MarkdownV2 would force escaping for ~19 — HTML is the smaller,
 *   safer escaping surface.
 * - Title = emoji + bold (`<b>`), blank-line separators, entity-first
 *   hierarchy, short field labels, mobile density (no ASCII tables, no
 *   long monospace, no emoji-per-word, no repeated data, no fake
 *   centering with spaces).
 * - Dates render through `formatDate()` (`7 sep 2026`, es-419 style);
 *   the underlying expiry CALCULATION is untouched.
 * - Statuses render through `renderStatus()`: 🟢 Vigente / 🟡 Por vencer
 *   / 🔴 Vencido. ⚪ Libre exists ONLY via `renderFreeSlot()` for
 *   truly-free slots — an expired slot NEVER renders as Libre.
 *
 * Escaping contract: every primitive takes RAW strings and escapes
 * dynamic content itself via `esc()`. Never pass the OUTPUT of one
 * primitive back through `esc()` (double-escaping). `unesc()` inverts
 * `esc()` for the reply-ownership round-trip (`parseOperatorLabel`).
 */

export const TELEGRAM_PARSE_MODE = 'HTML';

/** Statuses the renderer knows; anything else is escaped verbatim. */
export type StatusKind = 'Vigente' | 'Por vencer' | 'Vencido' | 'Sin dato';

/** Escape dynamic content for Telegram HTML (`&`, `<`, `>`). */
export function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Inverse of `esc()` (decode order matters: `&amp;` LAST so a literal
 * `&lt;` in the source round-trips instead of collapsing to `<`).
 */
export function unesc(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

const MONTHS_ES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
] as const;

/**
 * One human date format (`7 sep 2026`, es-419 style), parsed as UTC so
 * rendering is deterministic regardless of server timezone. `null` /
 * `undefined` (unknown expiry) render as `sin fecha`; an unparseable
 * value renders escaped-verbatim (markup can never break).
 */
export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return 'sin fecha';
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (match?.[1] === undefined || match?.[2] === undefined || match?.[3] === undefined) {
    return esc(value);
  }
  const monthIndex = Number(match[2]) - 1;
  const month = MONTHS_ES[monthIndex];
  if (month === undefined) {
    return esc(value);
  }
  return `${String(Number(match[3]))} ${month} ${match[1]}`;
}

/**
 * Central Spanish long date (`18 de septiembre de 2026`) for credential
 * expiry — the ONE format every credentials WhatsApp template and every
 * credential card uses, so copy swaps never fork the format. Strict
 * `YYYY-MM-DD` only; null/empty/unparseable returns null and the caller
 * renders the explicit gap (`sin fecha registrada`) — never a fake date,
 * never legacy DIAS, never another assignment's expiry.
 */
const MESES_ES_LARGO = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

export function formatExpiryLong(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match?.[1] === undefined || match?.[2] === undefined || match?.[3] === undefined) {
    return null;
  }
  const month = MESES_ES_LARGO[Number(match[2]) - 1];
  if (month === undefined) {
    return null;
  }
  return `${String(Number(match[3]))} de ${month} de ${match[1]}`;
}

/** Explicit expiry gap — shown when no valid `YYYY-MM-DD` exists. */
export function renderExpiryGap(): string {
  return 'sin fecha registrada';
}

/**
 * Central status renderer. Vencido NEVER renders as Libre — that domain
 * rule (BR-SLOT-005) is enforced here by construction: this function has
 * no code path that emits `Libre` for any input.
 */export function renderStatus(estatus: string): string {
  switch (estatus) {
    case 'Vigente':
      return '🟢 Vigente';
    case 'Por vencer':
      return '🟡 Por vencer';
    case 'Vencido':
      return '🔴 Vencido';
    case 'Sin dato':
      return 'Sin dato';
    default:
      return esc(estatus);
  }
}

/**
 * The ONLY sanctioned source of a `Libre` label: truly-free slots.
 * No status path calls this — see `renderStatus()`.
 */
export function renderFreeSlot(): string {
  return '⚪ Libre';
}

/** `(1 día)` / `(N días)` suffix; `null` (unknown) renders nothing. */
export function renderDias(dias: number | null): string {
  if (dias === null) {
    return '';
  }
  return dias === 1 ? ' (1 día)' : ` (${dias} días)`;
}

/** Title primitive: emoji + bold. Takes RAW text, escapes internally. */
export function title(text: string): string {
  return `<b>${esc(text)}</b>`;
}

/** Entity/subtitle line. Takes RAW text, escapes internally. */
export function subtitle(text: string): string {
  return esc(text);
}

/** Short `Label: value` field line. Both sides RAW, escaped internally. */
export function field(label: string, value: string): string {
  return `${esc(label)}: ${esc(value)}`;
}

/** Title + blank line + body block. Title RAW, body lines pre-rendered. */
export function section(titleText: string, bodyLines: string[]): string {
  return `${title(titleText)}\n\n${bodyLines.join('\n')}`;
}

/** Empty-state: title + blank line + hint (both RAW). */
export function emptyState(titleText: string, hint: string): string {
  return `${title(titleText)}\n\n${esc(hint)}`;
}

/** Not-found: title + blank + body + blank + retry hint (all RAW). */
export function notFound(titleText: string, body: string, hint: string): string {
  return `${title(titleText)}\n\n${esc(body)}\n\n${esc(hint)}`;
}

export interface RenderedSlot {
  /** Display service label (`FlujoTV`, `Netflix`, …) — RAW. */
  servicio: string;
  /** PERFIL as stored — RAW. */
  perfil: string;
  /** `FECHA QUE ACABA` as stored (`YYYY-MM-DD` or null) — RAW. */
  fechaFin: string | null;
  /** Derived status (domain calculation, passed in) — never `Libre`. */
  estatus: StatusKind | string;
  /** Calendar days to expiry (null when unknown). */
  dias: number | null;
  /** PAIS_CUENTA as stored (`''` renders as `—`) — RAW. */
  paisCuenta: string;
}

/**
 * Customer subscription line: service-first (one customer may hold
 * several services). The client name is NOT repeated here — it is the
 * card title.
 */
export function slotLine(slot: RenderedSlot): string {
  const pais = slot.paisCuenta === '' ? '—' : slot.paisCuenta;
  return (
    `• ${esc(slot.servicio)} — ${esc(slot.perfil)} — vence ${formatDate(slot.fechaFin)} — ` +
    `${renderStatus(slot.estatus)}${renderDias(slot.dias)} — País: ${esc(pais)}`
  );
}

/**
 * Single-client card: entity-first (name → phones → one block per
 * subscription). Same data as the legacy card — only layout/markup
 * changed. NEVER credentials: built from safe fields only.
 */
export function renderCustomerCard(input: {
  nombre: string;
  phones: string[];
  subscriptions: RenderedSlot[];
}): string {
  const lines: string[] = [
    title(`👤 ${input.nombre}`),
    `📞 ${input.phones.length > 0 ? input.phones.map((phone) => esc(phone)).join(' / ') : '—'}`,
    '',
  ];
  for (const sub of input.subscriptions) {
    lines.push(slotLine(sub), '');
  }
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}

/**
 * Service account card (Netflix grouped profiles, FlujoTV own-model
 * slots): service title → identifier → one line per slot. Same data as
 * the legacy card — only layout/markup changed. NEVER credentials.
 */
export function renderAccountCard(input: {
  servicio: string;
  identifier: string;
  slots: AccountSlot[];
}): string {
  const lines: string[] = [title(`📺 ${input.servicio} · ${input.identifier}`), ''];
  for (const slot of input.slots) {
    lines.push(accountSlotLine(slot), '');
  }
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}

/** One account slot: profile + holding client + expiry + status. */
export interface AccountSlot {  /** PERFIL as stored — RAW. */
  perfil: string;
  /** NOMBRE: the client holding this slot — RAW. */
  cliente: string;
  /** `FECHA QUE ACABA` as stored (`YYYY-MM-DD` or null) — RAW. */
  fechaFin: string | null;
  /** Derived status (domain calculation, passed in) — never `Libre`. */
  estatus: StatusKind | string;
  /** Calendar days to expiry (null when unknown). */
  dias: number | null;
  /** PAIS_CUENTA as stored (`''` renders as `—`) — RAW. */
  paisCuenta: string;
}

/**
 * Account slot line: same fields as the customer slot line plus the
 * holding client (each slot may belong to a different client); the
 * service prefix is dropped because the card title already names the
 * service once — no repeated data.
 */
export function accountSlotLine(slot: AccountSlot): string {
  const pais = slot.paisCuenta === '' ? '—' : slot.paisCuenta;
  return (
    `• ${esc(slot.perfil)} — ${esc(slot.cliente)} — vence ${formatDate(slot.fechaFin)} — ` +
    `${renderStatus(slot.estatus)}${renderDias(slot.dias)} — País: ${esc(pais)}`
  );
}

/** Compact multi-client list: names + phones only, details after selection. */
export function renderCustomerList(
  total: number,
  page: Array<{ nombre: string; phones: string[] }>,
  offset: number,
): string {
  const lines: string[] = [
    title(`🔎 ${total} clientes comparten ese número`),
    'Elige uno:',
    '',
  ];
  page.forEach((customer, index) => {
    const phones =
      customer.phones.length > 0
        ? customer.phones.map((phone) => esc(phone)).join(' / ')
        : '—';
    lines.push(`${offset + index + 1}. ${esc(customer.nombre)} — ${phones}`);
  });
  return lines.join('\n');
}

/** Minimal multi-account disambiguation header (buttons carry the choice). */
export function renderAccountChoices(total: number): string {
  return `${title(`🔎 ${total} cuentas comparten ese identificador`)}\nElige una:`;
}

/** Phone not-found (BR-CUS-008): report + retry/volver, NEVER Crear cliente. */
export function renderPhoneNotFound(): string {
  return notFound(
    '🔎 NO ENCONTRADO',
    'No encontramos ningún cliente asociado a ese número.',
    'Escribe otro número para reintentar o pulsa Volver.',
  );
}

/** Account not-found (BR-ACC-004): report + retry/volver, never creation. */
export function renderAccountNotFound(): string {
  return notFound(
    '🔎 CUENTA NO ENCONTRADA',
    'No encontramos esa cuenta.',
    'Escribe otra cuenta para reintentar o pulsa Volver.',
  );
}

/** Legacy service-row browse not-found: report + retry/volver. */
export function renderLegacyNotFound(query: string): string {
  return notFound(
    '🔎 SIN RESULTADOS',
    `“${query}” no coincide.`,
    'Escribe otro dato para reintentar o pulsa Volver.',
  );
}

/** Legacy service-row browse page (bare service words, e.g. `netflix`). */
export function renderLegacyList(
  total: number,
  page: Array<{ nombre: string; perfil: string; pais: string; estatus: string }>,
  offset: number,
): string {
  const lines: string[] = [title(`🔎 ${total} resultado(s) MOCK`)];
  page.forEach((row, index) => {
    lines.push(
      `${offset + index + 1}. ${esc(row.nombre)} — ${esc(row.perfil)} (${esc(row.pais)}, ${esc(row.estatus)})`,
    );
  });
  return lines.join('\n');
}

/** Legacy service-row detail: same fields, entity-first with short labels. */
export function renderLegacyDetail(
  row: { nombre: string; perfil: string; servicio: string; pais: string; estatus: string },
  index: number,
  total: number,
): string {
  return section(`👤 Cliente MOCK (${index + 1} de ${total})`, [
    field('Nombre', row.nombre),
    field('Perfil', row.perfil),
    field('Servicio', String(row.servicio)),
    field('País', row.pais),
    field('Estatus', row.estatus),
  ]);
}

/** Expired-accounts row: same fields as before, dynamic content escaped. */
export function expiredRow(row: {
  nombre: string;
  perfil: string;
  pais: string;
  estatus: string;
}): string {
  return `• ${esc(row.nombre)} — ${esc(row.perfil)} (${esc(row.pais)}, ${esc(row.estatus)})`;
}

/** Vencidos placeholder: same behavior (empty vs. top-5 list), new layout. */
export function renderExpired(
  rows: Array<{ nombre: string; perfil: string; pais: string; estatus: string }>,
  total: number = rows.length,
): string {
  if (total === 0) {
    return emptyState('⏰ Vencidos MOCK', 'Sin vencidos.');
  }
  return section(`⏰ Vencidos MOCK (${total})`, rows.map((row) => expiredRow(row)));
}

/** Inventory row: service + count, service name escaped. */
export function inventoryRow(row: { servicio: string; total: number }): string {
  return `• ${esc(row.servicio)}: ${row.total}`;
}

/** Inventario placeholder: same behavior (empty vs. per-service lines). */
export function renderInventory(rows: Array<{ servicio: string; total: number }>): string {
  if (rows.length === 0) {
    return emptyState('📦 Inventario MOCK', 'Vacío.');
  }
  return section('📦 Inventario MOCK', rows.map((row) => inventoryRow(row)));
}

function draftShell(body: string): string {
  return `${title('📝 OPERACIÓN PENDIENTE')}\n\n${body}`;
}

/** Draft opened (paso 1 de 2): same info + pending-operation title. */
export function renderDraftOpened(): string {
  return draftShell('Borrador MOCK abierto (paso 1 de 2). Envía la corrección o confirma.');
}

/** Draft resumed (paso 2 de 2): same info + pending-operation title. */
export function renderDraftResumed(months: number): string {
  return draftShell(`Borrador retomado: ${months} mes(es) (paso 2 de 2). Confirma o cancela.`);
}

/** Draft created with months: same info + pending-operation title. */
export function renderDraftCreated(months: number): string {
  return draftShell(`Borrador MOCK: ${months} mes(es). Confirma, corrige o cancela.`);
}

/** Draft updated with months: same info + pending-operation title. */
export function renderDraftUpdated(months: number): string {
  return draftShell(`Borrador actualizado: ${months} mes(es) (paso 2 de 2). Confirma o cancela.`);
}

/** Ownership warning for cross-actor confirm/cancel/correct (RAW owner). */
export function renderOwnershipWarning(ownerName: string): string {
  return `⚠️ Esta operación pertenece a ${esc(ownerName)}.`;
}

/**
 * Secrets-free confirmed-operation summary for the activity topic:
 * name + month count only — NEVER passwords, PINs, or credentials.
 */
export function renderActivitySummary(actorName: string, months?: number): string {
  const actor = esc(actorName);
  if (months !== undefined) {
    return `✅ Operación confirmada — ${actor} (${months} mes(es)).`;
  }
  return `✅ Operación confirmada — ${actor}.`;
}

export interface AlertInput {
  title: string;
  summary: string;
  actorName?: string;
  timestamp?: string;
}

/**
 * Critical alert (`⭐ ALERTA`): caller-provided strings rendered into the
 * alerts topic. NEVER pass secrets — the text posts verbatim downstream.
 */
export function renderAlert(alert: AlertInput): string {  const lines = [title('⭐ ALERTA'), title(alert.title), '', esc(alert.summary), ''];
  if (alert.actorName !== undefined && alert.actorName !== '') {
    lines.push(`👤 Operador: ${esc(alert.actorName)}`);
  }
  if (alert.timestamp !== undefined && alert.timestamp !== '') {
    lines.push(`🕒 ${esc(alert.timestamp)}`);
  }
  return lines.join('\n');
}

/** Explicit-credential card input: ONE CredentialBundle's safe view (RAW strings, escaped here). */
export interface RenderedCredential {
  /** Display service label (`Netflix`, `FlujoTV`) — RAW. */
  serviceLabel: string;
  /** CORREO as stored (email, username or code) — RAW. */
  accountIdentifier: string;
  /** Real credential — rendered ONLY on the explicit datos path. */
  accountPassword: string;
  /** PERFIL as stored — RAW. */
  profile: string;
  /** Per-service shape — FlujoTV keeps its own model. */
  accountType: 'netflix-profile' | 'flujotv-shared' | 'flujotv-complete';
  /** Holding client — RAW. */
  customerName: string;
  /** `FECHA QUE ACABA` of THIS assignment (`YYYY-MM-DD` or null) — RAW. */
  fechaFin?: string | null;
  /** Real PIN — present ONLY when source carries one; otherwise omitted. */
  pin?: string;
}

/**
 * Sensitive access-data card (Slice A — SHOW_CREDENTIALS ONLY): HTML via
 * the central renderer, every dynamic value escaped. Shown ONLY after an
 * explicit datos request inside the actor's authorized operating topic —
 * normal search cards never include passwords/PIN. Netflix shows the
 * account password + profile + 🔒 PIN; FlujoTV shows its own model
 * (Usuario + Perfil for shared, Usuario + Completa for exclusive). The
 * card carries THIS assignment's expiry (long Spanish format, explicit
 * gap when unknown — never another assignment's, never invented).
 */
export function renderCredentialCard(bundle: RenderedCredential): string {
  const lines: string[] = [
    title('🔐 DATOS DE ACCESO'),
    '',
    field('Cliente', bundle.customerName),
    field('Servicio', bundle.serviceLabel),
  ];
  if (bundle.accountType === 'netflix-profile') {
    lines.push(field('Cuenta', bundle.accountIdentifier));
    lines.push(field('Perfil', bundle.profile));
  } else {
    lines.push(field('Usuario', bundle.accountIdentifier));
    if (bundle.accountType === 'flujotv-complete') {
      lines.push(field('Cuenta', 'Completa / Exclusiva'));
    } else {
      lines.push(field('Perfil', bundle.profile));
    }
  }
  const expiry = formatExpiryLong(bundle.fechaFin ?? null) ?? renderExpiryGap();
  lines.push(`📅 Vence: ${esc(expiry)}`);
  lines.push(field('Contraseña', bundle.accountPassword));
  if (bundle.pin !== undefined && bundle.pin !== '') {
    lines.push(`🔒 PIN: ${esc(bundle.pin)}`);
  }
  return lines.join('\n');
}

/** One assignment block for the multi-assignment first card (all RAW, escaped here). */
export interface RenderedCredentialAssignment {
  /** 1-based position — UX numbering only, resolution uses stable keys. */
  numeral: string;
  /** Display service label (`Netflix`, `FlujoTV`) — RAW. */
  serviceLabel: string;
  /** PERFIL as stored — RAW. */
  profile: string;
  /** Short safe disambiguator (client or account id) — RAW, shown only when set. */
  disambiguator?: string;
  /** Derived status (domain calculation, passed in). */
  estatus: StatusKind | string;
  /** Calendar days to expiry (null when unknown). */
  dias: number | null;
  /** `FECHA QUE ACABA` of THIS assignment (`YYYY-MM-DD` or null) — RAW. */
  fechaFin: string | null;
  /** PAIS_CUENTA as stored — shown ONLY when non-empty. */
  paisCuenta?: string;
}

/**
 * TRANSVERSAL RULE — when choosing between accounts, every option shows
 * the minimum identifier to recognize it: service + profile/slot +
 * account identifier (+ expiry + status when those fields really exist,
 * never invented). Service/type alone is never enough — two options on
 * the same service stay ambiguous without the identifier, and
 * same-account options differentiate by profile/slot
 * (`Netflix · Perfil 1 · cuenta@gmail.com` style). Callers pass the
 * identifier via `disambiguator` (full value, escaped here); the card
 * header already names the client when scoped to one, so the client name
 * is NOT repeated inside the blocks — the identifier is the real
 * differentiator.
 *
 * Multi-assignment FIRST card: compact blocks (title bold, blank-line
 * separators, short lines, empty fields omitted — never `País: —`),
 * one per assignment, so the operator picks the assignment directly —
 * never a long card plus a generic Datos button forcing a second
 * selector. Buttons (built by the caller, one per block, same order)
 * resolve stable assignment keys; the numeral is UX only.
 */
export function renderCredentialAssignmentList(
  total: number,
  assignments: RenderedCredentialAssignment[],
): string {
  const lines: string[] = [`${title(`🔐 ¿Qué datos necesitas? (${total})`)}\nElige una opción:`];
  for (const assignment of assignments) {
    const head =
      assignment.disambiguator !== undefined && assignment.disambiguator !== ''
        ? `${assignment.numeral} ${assignment.serviceLabel} · ${assignment.profile} · ${assignment.disambiguator}`
        : `${assignment.numeral} ${assignment.serviceLabel} · ${assignment.profile}`;
    lines.push('', esc(head));
    lines.push(
      `${renderStatus(assignment.estatus)}${renderDias(assignment.dias)}`,
    );
    const expiry = formatExpiryLong(assignment.fechaFin) ?? renderExpiryGap();
    lines.push(`📅 Vence: ${esc(expiry)}`);
    if (assignment.paisCuenta !== undefined && assignment.paisCuenta.trim() !== '') {
      lines.push(`🌎 País: ${esc(assignment.paisCuenta.trim())}`);
    }
  }
  return lines.join('\n');
}

/** Minimal credential disambiguation header (buttons carry the choice). */
export function renderCredentialChoices(total: number): string {
  return `${title(`🔐 ¿Qué datos necesitas? (${total})`)}\nElige una opción:`;
}

/** No-context guide: credentials require a selected client/account first. */
export function renderCredentialNoContext(): string {
  return notFound(
    '🔐 DATOS DE ACCESO',
    'Primero busca un cliente o una cuenta y selecciónalo.',
    'Escribe un teléfono, nombre o cuenta para buscar.',
  );
}

// ---------------------------------------------------------------------------
// NewSale cards (Slice A — proposal only, NEVER credentials).
// ---------------------------------------------------------------------------

/** Human modality label — fixed strings, never raw PERFIL values. */
export function saleModalityLabel(modality: string): string {
  switch (modality) {
    case 'netflix-profile':
      return 'Netflix · Perfil';
    case 'flujotv-shared':
      return 'FlujoTV · Compartida';
    case 'flujotv-complete':
      return 'FlujoTV · Completa / Exclusiva';
    default:
      return modality;
  }
}

/** NewSale summary input: plain data, zero secrets by construction. */
export interface RenderedNewSaleSummary {
  /** Existing client name, or proposed name when new. */
  customerName: string;
  /** Operational phone as given. */
  phone: string;
  /** True when the customer is proposed (created only at confirm). */
  isNewCustomer: boolean;
  modality: 'netflix-profile' | 'flujotv-shared' | 'flujotv-complete' | string;
  requestedMonths: number;
  grantedMonths: number;
  /** `serviceAccountId · perfil` proposal line — never credentials. */
  assignment?: string;
  emergencyPending?: boolean;
  suggestedAmount: number | null;
  suggestedCurrency?: string;
  actualAmount: number | null;
  currency: string | null;
  methodLabel: string | null;
  receivedBy: string | null;
  reference?: string;
  pricePolicy?: string;
}

/**
 * Single-card sale summary (Slice A): everything the operator stated +
 * the inventory proposal + suggested-vs-real money. NEVER password/PIN:
 * the input type carries no credential field, so the card cannot leak
 * one (pre-confirm secrecy — Slice B confirms before any access data).
 */
export function renderNewSaleSummary(input: RenderedNewSaleSummary): string {
  const lines: string[] = [
    title('🧾 VENTA NUEVA — BORRADOR'),
    '',
    field('Cliente', input.isNewCustomer ? `${input.customerName} (nuevo)` : input.customerName),
    field('Teléfono', input.phone),
    field('Servicio', saleModalityLabel(input.modality)),
    field(
      'Duración',
      input.requestedMonths === input.grantedMonths
        ? `${input.grantedMonths} mes(es)`
        : `solicitado ${input.requestedMonths} / otorgado ${input.grantedMonths}`,
    ),
  ];
  if (input.assignment !== undefined && input.assignment !== '') {
    lines.push(field('Asigna', input.assignment));
  }
  if (input.emergencyPending === true) {
    lines.push('⚠️ Inventario de emergencia — falta autorización explícita.');
  }
  if (input.suggestedAmount !== null) {
    const currency = input.suggestedCurrency ?? input.currency ?? '';
    lines.push(field('Sugerido', `${input.suggestedAmount} ${currency}`.trim()));
  }
  if (input.actualAmount !== null) {
    lines.push(field('Recibido', `${input.actualAmount} ${input.currency ?? ''}`.trim()));
  }
  if (input.methodLabel !== null) {
    lines.push(field('Método', input.methodLabel));
  }
  if (input.receivedBy !== null) {
    lines.push(field('Recibido por', input.receivedBy));
  }
  if (input.reference !== undefined && input.reference !== '') {
    lines.push(field('Referencia', input.reference));
  }
  if (input.pricePolicy !== undefined && input.pricePolicy !== '') {
    lines.push(field('Política', input.pricePolicy));
  }
  return lines.join('\n');
}

/**
 * Emergency inventory card (BR-NFX-005): explicit ⚠️ warning, separate
 * from sale confirmation. Shown ONLY when no commercial slot is free;
 * Slice B attaches [Usar emergencia][Cancelar] to this same card.
 */
export function renderEmergencyInventoryCard(input: { identifier: string; perfil: string }): string {
  return (
    `${title('⚠️ INVENTARIO DE EMERGENCIA')}\n\n` +
    `${esc('No queda inventario comercial. Solo hay un perfil de emergencia disponible:')}\n` +
    `${field('Cuenta', input.identifier)}\n` +
    `${field('Perfil', input.perfil)}\n\n` +
    `${esc('Usarlo requiere tu autorización explícita.')}`
  );
}

/**
 * New-customer prompt INSIDE the sale (BR-CUS-009): phone unknown →
 * complete the sale collecting name+phone (location only if the model
 * supports it — never blocking). No persistence happens here.
 */
export function renderNewCustomerSalePrompt(phone: string): string {
  return notFound(
    '🧾 VENTA NUEVA',
    `No encuentro cliente para ${phone}. Completemos la venta: envía el nombre del cliente para este número.`,
    'Envía el nombre, o Volver para buscar otro número.',
  );
}

/** No-inventory report (BR-SAL-010): inform only, never create anything. */
export function renderSaleNoInventory(): string {
  return notFound(
    '🧾 VENTA NUEVA',
    'No hay inventario disponible.',
    'Puedes revisar inventario, volver o cancelar.',
  );
}

/** Split-payment refusal (BR-PAY-008 pending): one method per operation. */
export function renderSaleSplitRefused(): string {
  return (
    `${title('🧾 VENTA NUEVA')}\n\n` +
    `${esc('Por ahora cada venta usa un solo método de pago.')}\n` +
    `${esc('Dime cuál usamos: Pago Móvil, Zelle o Binance.')}`
  );
}

/** Netflix completa report (BR-NFX-007 pending): not sold in Slice A. */
export function renderSaleUnsupportedNetflixComplete(): string {
  return (
    `${title('🧾 VENTA NUEVA')}\n\n` +
    `${esc('La cuenta completa de Netflix aún no está definida (precio y reglas pendientes).')}\n` +
    `${esc('Puedo venderte un perfil de Netflix, o FlujoTV compartida/completa.')}`
  );
}

/** Ask-only-missing line for one sale field (BR-SAL-003, BR-UX-001). */
export function renderSaleAskMissing(fieldName: string): string {
  switch (fieldName) {
    case 'service':
      return '🧾 ¿Qué servicio vendemos: Netflix o FlujoTV?';
    case 'modality':
      return '🧾 ¿Modalidad de FlujoTV: compartida o completa?';
    case 'customer':
      return '🧾 ¿A qué teléfono va la venta? Envía el número.';
    case 'months':
      return '🧾 ¿Por cuántos meses? (ej. «2 meses»).';
    case 'method':
      return '🧾 ¿Método de pago: Pago Móvil, Zelle o Binance?';
    case 'amount':
      return '🧾 ¿Cuánto se recibió? (ej. «recibí 5 USDT»).';
    case 'receiver':
      return '🧾 ¿Quién recibió el dinero: Gabriel o Edward?';
    default:
      return '🧾 Falta un dato para completar la venta.';
  }
}

/**
 * Batched missing-fields card (smallest-turns invariant): when several
 * INDEPENDENT fields are missing they are asked ONCE, together, with a
 * combined example — the operator answers all in ONE message and the
 * next card shows ONLY the still-missing remainder (never re-asks
 * resolved fields). A single missing field delegates to
 * `renderSaleAskMissing` unchanged. Sequential decisions (service/
 * modality choice, emergency auth) never batch — they keep their own
 * cards and buttons.
 */
export function renderSaleAskMissingBatch(
  fields: string[],
  opts?: { customerNameForPhone?: string },
): string {
  const ordered = fields.filter((field, index) => fields.indexOf(field) === index);
  if (ordered.length === 0) {
    return '🧾 Todo listo — preparo el resumen.';
  }
  if (ordered.length === 1 && ordered[0] !== undefined) {
    return renderSaleAskMissing(ordered[0]);
  }
  const bullets: string[] = [];
  const nouns: string[] = [];
  if (ordered.includes('service')) {
    bullets.push('• Servicio: ¿Qué servicio vendemos: Netflix o FlujoTV?');
    nouns.push('servicio');
  }
  if (ordered.includes('modality')) {
    bullets.push('• Modalidad de FlujoTV: compartida o completa.');
    nouns.push('modalidad');
  }
  if (ordered.includes('customer')) {
    // New-customer convergence: phone unknown → ask the phone; phone
    // known but customer unresolved → ask the NAME for that number
    // (never the phone again). Both keep the `nombre del cliente`
    // wording the foreground regression asserts.
    if (opts?.customerNameForPhone !== undefined && opts.customerNameForPhone !== '') {
      bullets.push(
        `• Nombre del cliente para ${opts.customerNameForPhone}: envíalo en un mensaje.`,
      );
      nouns.push('nombre del cliente');
    } else {
      bullets.push('• Teléfono del cliente: envía el número.');
      nouns.push('teléfono');
    }
  }
  if (ordered.includes('months')) {
    bullets.push('• Duración: ej. «2 meses» o «30 días».');
    nouns.push('duración');
  }
  if (ordered.includes('method')) {
    bullets.push('• Método de pago: Pago Móvil, Zelle o Binance.');
    nouns.push('método de pago');
  }
  if (ordered.includes('amount')) {
    bullets.push('• Monto recibido: ej. «recibí 5 USDT».');
    nouns.push('monto');
  }
  if (ordered.includes('receiver')) {
    bullets.push('• Quién recibió el dinero: Gabriel o Edward.');
    nouns.push('receptor');
  }
  const lines = [
    `🧾 Venta nueva — faltan ${ordered.length} datos, respóndelos en UN mensaje:`,
    `Faltan: ${nouns.join(', ')}.`,
    '',
    ...bullets,
    '',
    'Ej.: «Zelle, 4 dólares, lo recibió Edward».',
  ];
  return lines.join('\n');
}

/**
 * Post-confirm single card (Slice B): the SAME summary the operator
 * confirmed, headed ✅ VENTA CONFIRMADA, followed by the Datos access
 * block. The caller appends the Fase 3 WhatsApp delivery line
 * (`WHATSAPP_PREPARED_TEXT`) plus the `💬 Abrir WhatsApp` URL button via
 * `credentialCardKeyboard` — this function owns only the header framing
 * so credential/WhatsApp copy never forks. Repeat confirms pass
 * `alreadyConfirmed` for the explicit `(ya registrada)` marker.
 */
export function renderSaleConfirmed(
  summary: string,
  datos: string,
  alreadyConfirmed = false,
): string {
  const head = alreadyConfirmed ? '✅ VENTA CONFIRMADA (ya registrada)' : '✅ VENTA CONFIRMADA';
  return `${title(head)}\n\n${summary}\n\n${datos}`;
}

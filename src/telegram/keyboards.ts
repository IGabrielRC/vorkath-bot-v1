/**
 * Telegram inline keyboards. L1 deterministic navigation: every callback
 * routes by exact short-id match — Gemini is never consulted.
 *
 * Telegram caps `callback_data` at 64 bytes, so actions travel as
 * versioned short ids (`v1:<short>`) resolved through the table below.
 * See: https://core.telegram.org/bots/api#inlinekeyboardbutton
 */

import { esc, title } from './render';

/** Display name for a stored service id (`netflix` → `Netflix`). */
function prettyService(servicio: string): string {
  const compact = servicio.replace(/\s+/g, '').toLowerCase();
  if (compact === 'flujotv') {
    return 'FlujoTV';
  }
  if (compact === 'netflix') {
    return 'Netflix';
  }
  return servicio;
}

export const CALLBACK_VERSION = 'v1';
/** Telegram hard limit for InlineKeyboardButton.callback_data, in bytes. */
export const CALLBACK_MAX_BYTES = 64;

export type CallbackAction =
  | 'home'
  | 'operar'
  | 'buscar'
  | 'vencidos'
  | 'inventario'
  | 'caja'
  | 'mas'
  | 'back'
  | 'confirm'
  | 'correct'
  | 'cancel'
  | 'credentials'
  | 'services'
  | 'saleNew'
  | 'saleEmergency'
  | 'saleKeep'
  | 'saleModNetflix'
  | 'saleModFlujoShared'
  | 'saleModFlujoComplete'
  | 'view0'
  | 'view1'
  | 'view2'
  | 'view3'
  | 'view4'
  | 'next'
  | 'prev';

const SHORT_IDS: Record<CallbackAction, string> = {
  home: 'home',
  operar: 'operar',
  buscar: 'buscar',
  vencidos: 'venc',
  inventario: 'inv',
  caja: 'caja',
  mas: 'more',
  back: 'back',
  confirm: 'ok',
  correct: 'fix',
  cancel: 'no',
  credentials: 'cred',
  services: 'svc',
  saleNew: 'snew',
  saleEmergency: 'semg',
  saleKeep: 'skeep',
  saleModNetflix: 'snfx',
  saleModFlujoShared: 'sshr',
  saleModFlujoComplete: 'sfull',
  view0: 'w0',
  view1: 'w1',
  view2: 'w2',
  view3: 'w3',
  view4: 'w4',
  next: 'nx',
  prev: 'pv',
};

export interface InlineKeyboardButton {
  text: string;
  /**
   * Callback payload (L1 routing). Absent on direct-URL buttons
   * (`💬 Abrir WhatsApp` opens wa.me — no callback fires, the operator
   * presses send manually). At least one of `callback_data`/`url` is set.
   * See: https://core.telegram.org/bots/api#inlinekeyboardbutton
   */
  callback_data?: string;
  /** Direct URL — used ONLY by the WhatsApp delivery button. */
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/** Versioned short callback_data for an action. Always <=64 bytes. */
export function callbackData(action: CallbackAction): string {
  return `${CALLBACK_VERSION}:${SHORT_IDS[action]}`;
}

/**
 * Interaction-bound callback_data (`v1:<short>:<interactionId>`). Every
 * interactive button carries its interaction id so the server can resolve
 * ownership (chat → owner → state) before executing anything. The 8-hex
 * interaction ids keep every variant far below the 64-byte cap.
 */
export function callbackDataFor(action: CallbackAction, interactionId: string): string {
  return `${CALLBACK_VERSION}:${SHORT_IDS[action]}:${interactionId}`;
}

export interface ParsedCallback {
  action: CallbackAction;
  /** Present on interaction-bound buttons; absent on legacy buttons. */
  interactionId?: string;
}

/** Every callback_data this shell can route. Unknown ids are stale → safe no-op. */
export const KNOWN_CALLBACK_IDS: readonly string[] = (
  Object.keys(SHORT_IDS) as CallbackAction[]
).map((action) => callbackData(action));

const idToAction = new Map<string, CallbackAction>(
  (Object.keys(SHORT_IDS) as CallbackAction[]).map((action) => [callbackData(action), action]),
);

/** Resolves callback_data to an action, or null for stale/unknown data. */
export function parseCallback(data: string | undefined): CallbackAction | null {
  return parseCallbackData(data)?.action ?? null;
}

/**
 * Resolves callback_data to action + optional interaction id. Legacy
 * unbound buttons (`v1:<short>`) yield no interactionId; bound buttons
 * (`v1:<short>:<id>`) yield it. Anything else is stale → null.
 */
export function parseCallbackData(data: string | undefined): ParsedCallback | null {
  if (typeof data !== 'string' || data.length === 0) {
    return null;
  }
  const direct = idToAction.get(data);
  if (direct !== undefined) {
    return { action: direct };
  }
  const parts = data.split(':');
  if (parts.length === 3 && parts[0] === CALLBACK_VERSION) {
    const action = idToAction.get(`${parts[0]}:${parts[1]}`);
    const interactionId = parts[2];
    if (action !== undefined && interactionId !== undefined && interactionId.length > 0) {
      return { action, interactionId };
    }
  }
  return null;
}

/**
 * Visual ownership label. Backend enforcement is the real security; this
 * line only shows who owns the interaction. Every button-bearing message
 * (or message expecting continuation) carries it via `withOperator`.
 * The name is HTML-escaped (central HTML parse_mode); `parseOperatorLabel`
 * in `webhook.ts` decodes it back so the reply-ownership round-trip keeps
 * working for hostile names.
 */
export function operatorLabel(name: string | undefined): string {
  const display = name !== undefined && name.trim() !== '' ? name : 'Operador';
  return `👤 Operador: ${esc(display)}`;
}

/** Appends the ownership label line to an interactive message. */
export function withOperator(text: string, name: string | undefined): string {
  return `${text}\n${operatorLabel(name)}`;
}

export const HOME_TEXT = `${title('🏠 Vokath')}\n¿qué hacemos hoy?`;

export const SECTION_TEXTS: Record<string, string> = {
  operar: `${title('⚡ OPERAR')}\nCrea una prueba MOCK o corrige el borrador abierto.`,
  buscar: `${title('🔎 BUSCAR')}\nEnvía un teléfono, correo o nombre a buscar.`,
  vencidos: `${title('⏰ Vencidos MOCK')}\nPróximos vencimientos.`,
  inventario: `${title('📦 Inventario MOCK')}\nExistencias.`,
  caja: `${title('💰 CAJA')}\nResumen MOCK.`,
  mas: `${title('⋯ MÁS')}\nTasa, precios y código de instalación.`,
};

export const DRAFT_TEXT = `${title('📝 OPERACIÓN PENDIENTE')}\n\nBorrador MOCK abierto. Confirma, corrige o cancela.`;

function button(text: string, action: CallbackAction): InlineKeyboardButton {
  return { text, callback_data: callbackData(action) };
}

function ownedButton(
  text: string,
  action: CallbackAction,
  interactionId: string | undefined,
): InlineKeyboardButton {
  if (interactionId === undefined) {
    return { text, callback_data: callbackData(action) };
  }
  return { text, callback_data: callbackDataFor(action, interactionId) };
}

export function backButton(interactionId?: string): InlineKeyboardButton {
  return ownedButton('←Volver', 'back', interactionId);
}

/** Direct wa.me opener: URL button, NO callback, NO copy-paste portal. */
export function whatsappUrlButton(url: string): InlineKeyboardButton {
  return { text: '💬 Abrir WhatsApp', url };
}

/**
 * Credential card keyboard (Slice A card + Slice B delivery): the
 * `💬 Abrir WhatsApp` URL button ONLY when a valid wa.me link was
 * prepared (automatic whenever bundle+phone+E.164 are unambiguous —
 * datos → 1 tap → WhatsApp), the `[← Servicios]` owned button ONLY when
 * the card came from a multi-assignment selector (restores the selector
 * card in place), plus [🔎Buscar otra][←Volver] (search-again + Volver).
 * The sensitive card never carries a 🔐Datos button (it IS the datos
 * view) and drafts stay untouched.
 */
export function credentialCardKeyboard(
  interactionId?: string,
  whatsappUrl?: string,
  opts?: { showServices?: boolean },
): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];
  if (whatsappUrl !== undefined) {
    rows.push([whatsappUrlButton(whatsappUrl)]);
  }
  if (opts?.showServices === true) {
    rows.push([ownedButton('← Servicios', 'services', interactionId)]);
  }
  rows.push([ownedButton('🔎Buscar otra', 'buscar', interactionId), backButton(interactionId)]);
  return { inline_keyboard: rows };
}

/** /start Home keyboard: six spec buttons (owned when interactionId set). */
export function homeKeyboard(interactionId?: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        ownedButton('⚡OPERAR', 'operar', interactionId),
        ownedButton('🔎BUSCAR', 'buscar', interactionId),
      ],
      [
        ownedButton('⏰VENCIDOS', 'vencidos', interactionId),
        ownedButton('📦INVENTARIO', 'inventario', interactionId),
      ],
      [
        ownedButton('💰CAJA', 'caja', interactionId),
        ownedButton('⋯MÁS', 'mas', interactionId),
      ],
    ],
  };
}

/** Section placeholder keyboard: contextual text + ←Volver (nav-stack pop). */
export function sectionKeyboard(section: string, interactionId?: string): InlineKeyboardMarkup {
  void section;
  return {
    inline_keyboard: [[backButton(interactionId)]],
  };
}

/**
 * Phone-search keyboard: [🔐Datos] runs the SAME deterministic
 * SHOW_CREDENTIALS tool the explicit datos phrases run (button≡NL);
 * [🔎Buscar otro] re-opens the SAME guided wizard the BUSCAR button
 * opens (same `buscar` action/handler), and [←Volver] pops the nav
 * stack to the exact previous view.
 * Used by the read-only phone UX (not-found, single-card, customer
 * detail). NEVER a "Crear cliente" button here — creation belongs
 * exclusively to the explicit new-sale flow (BR-CUS-009).
 */
export function phoneSearchKeyboard(interactionId?: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [ownedButton('🔐Datos', 'credentials', interactionId)],
      [ownedButton('🔎Buscar otro', 'buscar', interactionId), backButton(interactionId)],
    ],
  };
}

/**
 * Account-search keyboard: [🔐Datos] runs the SAME deterministic
 * SHOW_CREDENTIALS tool the explicit datos phrases run (button≡NL);
 * [🔎Buscar otra] re-opens the SAME guided wizard the BUSCAR button
 * opens (same `buscar` action/handler), and [←Volver] pops the nav
 * stack to the exact previous view.
 * Used by the read-only account UX (not-found, single-card, account
 * detail). NEVER a "Crear cliente" button here — creation belongs
 * exclusively to the explicit new-sale flow (BR-CUS-009).
 */
export function accountSearchKeyboard(interactionId?: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [ownedButton('🔐Datos', 'credentials', interactionId)],
      [ownedButton('🔎Buscar otra', 'buscar', interactionId), backButton(interactionId)],
    ],
  };
}

/**
 * Minimal multi-service disambiguation: one owned button per matched
 * account (`Netflix · <id>`, `FlujoTV · <id>`), reusing the view0–4
 * actions so ownership, stale-callback and cross-thread guards apply
 * unchanged, plus ←Volver. Shown only when ONE identifier resolves
 * to N real accounts (e.g. the same identifier in Netflix AND
 * FlujoTV) — never a service question up front.
 */
/** Controlled button identifier truncation (full value lives on the card; buttons stay legible). */
export const ACCOUNT_BUTTON_IDENTIFIER_LIMIT = 24;

function shortAccountIdentifier(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > ACCOUNT_BUTTON_IDENTIFIER_LIMIT
    ? `${trimmed.slice(0, ACCOUNT_BUTTON_IDENTIFIER_LIMIT)}…`
    : trimmed;
}

export function accountDisambiguationKeyboard(
  accounts: Array<{ servicio: string; identifier: string }>,
  opts?: { interactionId?: string },
): InlineKeyboardMarkup {
  const shown = Math.min(accounts.length, VIEW_ACTIONS.length);
  const labels: string[] = [];
  for (let index = 0; index < shown; index += 1) {
    const account = accounts[index];
    if (account === undefined) {
      continue;
    }
    labels.push(`${prettyService(account.servicio)} · ${shortAccountIdentifier(account.identifier)}`);
  }
  return listView(labels, { ...opts });
}

/**
 * Minimal credential disambiguation: one owned button per candidate
 * bundle, labeled from real data (`Netflix · 1 PERFIL (2)`), reusing the
 * view0–4 actions so ownership, stale-callback and cross-thread guards
 * apply unchanged, plus ←Volver. Shown only when the actor's context
 * resolves to N assignments — never a free-text password dump.
 */
export function credentialDisambiguationKeyboard(
  labels: string[],
  opts?: { interactionId?: string },
): InlineKeyboardMarkup {
  return listView(labels.slice(0, VIEW_ACTIONS.length), { ...opts });
}

/** Draft actions: Confirmar / Corregir / Cancelar + ←Volver (nav-stack pop). */
export function draftKeyboard(interactionId?: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        ownedButton('✅Confirmar', 'confirm', interactionId),
        ownedButton('✏️Corregir', 'correct', interactionId),
      ],
      [ownedButton('❌Cancelar', 'cancel', interactionId), backButton(interactionId)],
    ],
  };
}

const VIEW_ACTIONS: CallbackAction[] = ['view0', 'view1', 'view2', 'view3', 'view4'];

/** UX numerals for ListView options (numbering is UX only — resolution uses stable keys). */
const LIST_NUMERALS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

export interface ListViewOpts {
  interactionId?: string;
  hasNext?: boolean;
  hasPrev?: boolean;
}

/**
 * ONE generic disambiguation/list view (transversal): numeral-prefixed
 * option buttons (2 per row, `view0–4` actions so ownership,
 * stale-callback and cross-thread guards apply unchanged), optional
 * Siguiente/Anterior pagination, plus ←Volver. Every button carries
 * the interaction id (stable keys — the numeral is UX only, resolution
 * uses stored state). The three legacy builders below delegate here —
 * same output, one layout to maintain.
 */
export function listView(labels: string[], opts?: ListViewOpts): InlineKeyboardMarkup {
  const interactionId = opts?.interactionId;
  const rows: InlineKeyboardButton[][] = [];
  const choiceRow: InlineKeyboardButton[] = [];
  const shown = Math.min(labels.length, VIEW_ACTIONS.length);
  for (let index = 0; index < shown; index += 1) {
    const label = labels[index];
    const action = VIEW_ACTIONS[index];
    if (label === undefined || action === undefined) {
      continue;
    }
    choiceRow.push(ownedButton(`${LIST_NUMERALS[index] ?? '•'} ${label}`, action, interactionId));
    if (choiceRow.length === 2) {
      rows.push(choiceRow.splice(0, 2));
    }
  }
  if (choiceRow.length > 0) {
    rows.push(choiceRow.splice(0, 2));
  }
  const navRow: InlineKeyboardButton[] = [];
  if (opts?.hasPrev === true) {
    navRow.push(ownedButton('←Anterior', 'prev', interactionId));
  }
  if (opts?.hasNext === true) {
    navRow.push(ownedButton('Siguiente→', 'next', interactionId));
  }
  if (navRow.length > 0) {
    rows.push(navRow);
  }
  rows.push([backButton(interactionId)]);
  return { inline_keyboard: rows };
}

/**
 * Search-result keyboard: one owned "Ver cliente" button per shown row
 * (index within the page), plus Siguiente/Anterior pagination when the
 * interaction has more pages, plus ←Volver. Every button carries the
 * SEARCH interaction id — a peer tapping them is rejected by owner.
 */
export function searchResultsKeyboard(
  shown: number,
  opts?: { interactionId?: string; hasNext?: boolean; hasPrev?: boolean },
): InlineKeyboardMarkup {
  const count = Math.max(0, Math.min(shown, VIEW_ACTIONS.length));
  return listView(Array.from({ length: count }, () => 'Ver cliente'), { ...opts });
}

/**
 * Sale entry keyboard (Slice B — OPERAR shows only currently-implemented
 * options): [🛒 Venta nueva] opens the guided NewSale card on the SAME
 * draft core the sale NL uses (button≡NL), plus ←Volver to Home.
 * Ownership/topics ride the standard owned-callback path — every button
 * carries the interaction id.
 */
export function saleEntryKeyboard(interactionId?: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [ownedButton('🛒 Venta nueva', 'saleNew', interactionId)],
      [backButton(interactionId)],
    ],
  };
}

/**
 * Sale progress keyboard (incomplete draft — NEVER Confirmar/Corregir):
 * only ←Volver / ❌Cancelar plus the valid next actions. When the
 * missing field is service/modality, the three sale option buttons let
 * the operator answer with one tap (button≡NL with the equivalent
 * sentence). Shown on ask-missing / new-customer / disambiguate /
 * clarification / no-inventory cards.
 */
export function saleProgressKeyboard(
  interactionId?: string,
  missing?: string,
): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];
  if (missing === 'service' || missing === 'modality') {
    rows.push([
      ownedButton('Netflix · Perfil', 'saleModNetflix', interactionId),
      ownedButton('FlujoTV · Perfil', 'saleModFlujoShared', interactionId),
    ]);
    rows.push([ownedButton('FlujoTV · Completa', 'saleModFlujoComplete', interactionId)]);
  }
  rows.push([ownedButton('❌Cancelar', 'cancel', interactionId), backButton(interactionId)]);
  return { inline_keyboard: rows };
}

/**
 * GLOBAL BUTTON VOCABULARY (transversal convention — HOTFIX 2, Part C).
 *
 * One meaning per label everywhere (recognition > memory):
 * - `✅Confirmar` — executes the ready operation (positive, terminal).
 *   Shown ONLY on ready drafts; never on incomplete or frozen cards.
 * - `❌Cancelar` — drops the open draft, persists nothing (destructive).
 *   Always beside a safe alternative (`←Volver` / `▶️ Continuar`).
 * - `←Volver` — pops the SAME interaction's nav stack (never Home
 *   except from an explicit root view; never resurrects terminal cards).
 * - `✏️Corregir` — asks for the correction text (never executes).
 * - `▶️ Continuar venta` — re-renders the intact draft (retry-safe).
 * - `💬 Abrir WhatsApp` — EXTERNAL url button (no callback, no state):
 *   the ONLY button a frozen confirmed card keeps.
 * - `🔎Buscar otr…` / option buttons (`1️⃣…`) / `←Anterior|Siguiente→`
 *   — list/pagination/empty-state pattern: options carry stable keys in
 *   interaction state (numbering is UX only); empty states name the
 *   retry explicitly (`Escribe otro… o pulsa Volver`) — no dead ends.
 *
 * Destructive/positive consistency: destructive (`❌Cancelar`, `⚠️ Usar
 * emergencia`) never shares a row with the positive `✅Confirmar`;
 * frozen terminal cards carry zero callbacks (WhatsApp URL excepted).
 * The renderer (`render.ts`) stays the single copy boundary — keyboards
 * own labels, never message text.
 */

/**
 * Frozen terminal card keyboard (HOTFIX 2 — ONE ACTIVE CARD):
 * terminal CONFIRMED/CANCELLED cards are never edited again, so they
 * carry zero tappable callbacks. A confirmed card keeps ONLY the
 * still-valid external action (the `💬 Abrir WhatsApp` URL button —
 * no callback fires, nothing mutates); a cancelled card carries no
 * buttons at all. Continuation lives on the fresh Home card below.
 */
export function saleFrozenKeyboard(whatsappUrl?: string): InlineKeyboardMarkup {
  if (whatsappUrl !== undefined) {
    return { inline_keyboard: [[whatsappUrlButton(whatsappUrl)]] };
  }
  return { inline_keyboard: [] };
}
/**
 * Pending-management keyboard (second operation while one is open):
 * [Continuar venta] re-renders the in-progress draft on the SAME card;
 * [❌Cancelar venta] drops it. Never a parallel operational card.
 */
export function salePendingKeyboard(interactionId?: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [ownedButton('▶️ Continuar venta', 'saleKeep', interactionId)],
      [ownedButton('❌Cancelar venta', 'cancel', interactionId)],
    ],
  };
}
/**
 * Emergency authorization keyboard (Slice B — BR-NFX-005): [Usar
 * emergencia] authorizes the profile-5 slot EXPLICITLY and separately
 * from sale confirmation (auth≠sale-confirm); [❌Cancelar] drops the
 * draft; ←Volver returns to Home. Never a Confirmar button here.
 */
export function saleEmergencyKeyboard(interactionId?: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [ownedButton('⚠️ Usar emergencia', 'saleEmergency', interactionId)],
      [ownedButton('❌Cancelar', 'cancel', interactionId), backButton(interactionId)],
    ],
  };
}

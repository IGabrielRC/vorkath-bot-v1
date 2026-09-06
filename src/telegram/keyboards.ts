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
  callback_data: string;
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

/** Section placeholder keyboard: contextual text + ←Volver to Home. */
export function sectionKeyboard(section: string, interactionId?: string): InlineKeyboardMarkup {
  void section;
  return {
    inline_keyboard: [[backButton(interactionId)]],
  };
}

/**
 * Phone-search keyboard: [🔎Buscar otro] re-opens the SAME guided
 * wizard the BUSCAR button opens (same `buscar` action/handler), and
 * [←Volver] returns Home. Used by the read-only phone UX (not-found,
 * single-card, customer detail). NEVER a "Crear cliente" button here —
 * creation belongs exclusively to the explicit new-sale flow
 * (BR-CUS-009).
 */
export function phoneSearchKeyboard(interactionId?: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [ownedButton('🔎Buscar otro', 'buscar', interactionId), backButton(interactionId)],
    ],
  };
}

/**
 * Account-search keyboard: [🔎Buscar otra] re-opens the SAME guided
 * wizard the BUSCAR button opens (same `buscar` action/handler), and
 * [←Volver] returns Home. Used by the read-only account UX
 * (not-found, single-card, account detail). NEVER a "Crear cliente"
 * button here — creation belongs exclusively to the explicit
 * new-sale flow (BR-CUS-009).
 */
export function accountSearchKeyboard(interactionId?: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
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
export function accountDisambiguationKeyboard(
  accounts: Array<{ servicio: string; identifier: string }>,
  opts?: { interactionId?: string },
): InlineKeyboardMarkup {
  const interactionId = opts?.interactionId;
  const numerals = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
  const rows: InlineKeyboardButton[][] = [];
  const choiceRow: InlineKeyboardButton[] = [];
  const shown = Math.min(accounts.length, VIEW_ACTIONS.length);
  for (let index = 0; index < shown; index += 1) {
    const account = accounts[index];
    const action = VIEW_ACTIONS[index];
    if (account === undefined || action === undefined) {
      continue;
    }
    const label = `${numerals[index] ?? '•'} ${prettyService(account.servicio)} · ${account.identifier}`;
    choiceRow.push(ownedButton(label, action, interactionId));
    if (choiceRow.length === 2) {
      rows.push(choiceRow.splice(0, 2));
    }
  }
  if (choiceRow.length > 0) {
    rows.push(choiceRow.splice(0, 2));
  }
  rows.push([backButton(interactionId)]);
  return { inline_keyboard: rows };
}

/** Draft actions: Confirmar / Corregir / Cancelar + ←Volver to Home. */
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
  const interactionId = opts?.interactionId;
  const rows: InlineKeyboardButton[][] = [];
  const numerals = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
  const viewRow: InlineKeyboardButton[] = [];
  for (let index = 0; index < shown && index < VIEW_ACTIONS.length; index += 1) {
    const action = VIEW_ACTIONS[index];
    if (action === undefined) {
      continue;
    }
    viewRow.push(ownedButton(`${numerals[index] ?? '•'} Ver cliente`, action, interactionId));
    if (viewRow.length === 2) {
      rows.push(viewRow.splice(0, 2));
    }
  }
  if (viewRow.length > 0) {
    rows.push(viewRow.splice(0, 2));
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

/**
 * Telegram inline keyboards. L1 deterministic navigation: every callback
 * routes by exact short-id match — Gemini is never consulted.
 *
 * Telegram caps `callback_data` at 64 bytes, so actions travel as
 * versioned short ids (`v1:<short>`) resolved through the table below.
 * See: https://core.telegram.org/bots/api#inlinekeyboardbutton
 */

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
  | 'cancel';

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

/** Every callback_data this shell can route. Unknown ids are stale → safe no-op. */
export const KNOWN_CALLBACK_IDS: readonly string[] = (
  Object.keys(SHORT_IDS) as CallbackAction[]
).map((action) => callbackData(action));

const idToAction = new Map<string, CallbackAction>(
  (Object.keys(SHORT_IDS) as CallbackAction[]).map((action) => [callbackData(action), action]),
);

/** Resolves callback_data to an action, or null for stale/unknown data. */
export function parseCallback(data: string | undefined): CallbackAction | null {
  if (typeof data !== 'string' || data.length === 0) {
    return null;
  }
  return idToAction.get(data) ?? null;
}

export const HOME_TEXT = '🏠 Vokath — ¿qué hacemos hoy?';

export const SECTION_TEXTS: Record<string, string> = {
  operar: '⚡ OPERAR (demo) — crea una prueba MOCK o corrige el borrador abierto.',
  buscar: '🔎 BUSCAR (demo) — envía un teléfono, correo o nombre a buscar.',
  vencidos: '⏰ VENCIDOS (demo) — próximos vencimientos MOCK.',
  inventario: '📦 INVENTARIO (demo) — existencias MOCK.',
  caja: '💰 CAJA (demo) — resumen MOCK.',
  mas: '⋯ MÁS (demo) — tasa, precios y código de instalación.',
};

export const DRAFT_TEXT = '📝 Borrador MOCK abierto. Confirma, corrige o cancela.';

function button(text: string, action: CallbackAction): InlineKeyboardButton {
  return { text, callback_data: callbackData(action) };
}

export function backButton(): InlineKeyboardButton {
  return button('←Volver', 'back');
}

/** /start Home keyboard: six spec buttons. */
export function homeKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('⚡OPERAR', 'operar'), button('🔎BUSCAR', 'buscar')],
      [button('⏰VENCIDOS', 'vencidos'), button('📦INVENTARIO', 'inventario')],
      [button('💰CAJA', 'caja'), button('⋯MÁS', 'mas')],
    ],
  };
}

/** Section placeholder keyboard: contextual text + ←Volver to Home. */
export function sectionKeyboard(section: string): InlineKeyboardMarkup {
  void section;
  return {
    inline_keyboard: [[backButton()]],
  };
}

/** Draft actions: Confirmar / Corregir / Cancelar + ←Volver to Home. */
export function draftKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('✅Confirmar', 'confirm'), button('✏️Corregir', 'correct')],
      [button('❌Cancelar', 'cancel'), backButton()],
    ],
  };
}

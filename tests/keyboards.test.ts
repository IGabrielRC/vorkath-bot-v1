import { describe, expect, it } from 'vitest';
import {
  CALLBACK_MAX_BYTES,
  KNOWN_CALLBACK_IDS,
  SECTION_TEXTS,
  backButton,
  callbackData,
  draftKeyboard,
  homeKeyboard,
  parseCallback,
  sectionKeyboard,
} from '../src/telegram/keyboards';

describe('keyboards L1 (RED: zero Gemini — pure lookup tables)', () => {
  it('renders /start Home with the six spec buttons', () => {
    const markup = homeKeyboard();
    const flat = markup.inline_keyboard.flat().map((b) => b.text);
    for (const label of ['⚡OPERAR', '🔎BUSCAR', '⏰VENCIDOS', '📦INVENTARIO', '💰CAJA', '⋯MÁS']) {
      expect(flat).toContain(label);
    }
  });

  it('keeps every callback_data short (<=64 bytes) and versioned', () => {
    const ids = [...KNOWN_CALLBACK_IDS, callbackData('home')];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(Buffer.byteLength(id, 'utf8')).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
      expect(id.startsWith('v1:')).toBe(true);
    }
  });

  it('exposes section placeholders plus a ←Volver back button', () => {
    for (const action of ['operar', 'buscar', 'vencidos', 'inventario', 'caja', 'mas'] as const) {
      expect(SECTION_TEXTS[action]).toBeTruthy();
      const markup = sectionKeyboard(action);
      const flat = markup.inline_keyboard.flat();
      expect(flat.some((b) => b.text === '←Volver')).toBe(true);
      expect(flat.every((b) => Buffer.byteLength(b.callback_data, 'utf8') <= CALLBACK_MAX_BYTES)).toBe(
        true,
      );
    }
    expect(backButton().text).toBe('←Volver');
  });

  it('exposes draft Confirmar/Corregir/Cancelar actions', () => {
    const flat = draftKeyboard().inline_keyboard.flat().map((b) => b.text);
    expect(flat).toEqual(expect.arrayContaining(['✅Confirmar', '✏️Corregir', '❌Cancelar']));
  });

  it('parses known callbacks and returns null for stale/unknown data', () => {
    expect(parseCallback(callbackData('buscar'))).toBe('buscar');
    expect(parseCallback('v1:stale-action-xyz')).toBeNull();
    expect(parseCallback(undefined)).toBeNull();
    expect(parseCallback('')).toBeNull();
  });
});

/**
 * Central pre-send length guard (Telegram 4096 cap): oversized cards
 * split into same-thread parts without cutting HTML tags/entities or
 * dropping critical data (phone/amount/date/identifier).
 */

import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_MAX_TEXT_LENGTH,
  fitsTelegramLimit,
  splitTelegramText,
} from '../src/telegram/lengthGuard';
import { renderExpired } from '../src/telegram/render';

const DANGLING_ENTITY = /&[A-Za-z0-9#]+$/;
const DANGLING_TAG = /<[^<>]*$/;

describe('lengthGuard', () => {
  it('passes short texts through as one identical part', () => {
    const text = '<b>🏠 Vokath</b>\n¿qué hacemos hoy?';
    expect(fitsTelegramLimit(text)).toBe(true);
    expect(splitTelegramText(text)).toEqual([text]);
  });

  it('splits an oversized rendered card without losing rows or breaking markup', () => {
    const rows = Array.from({ length: 400 }, (_, index) => ({
      nombre: `Cliente ${index} Hernández`,
      perfil: `PERFIL ${index}`,
      pais: 'Venezuela',
      estatus: index % 2 === 0 ? 'Vencido' : 'Por vencer',
    }));
    // Critical tokens a real card carries: phone-like ids, amounts,
    // dates, identifiers, plus HTML tags/entities from the renderer.
    const card =
      `${renderExpired(rows, rows.length)}\n` +
      '📞 0414-5460657 · Ref ABC-123 · $8.00 USD · vence 2026-09-07 · cuenta maxnet050 &amp; <b>negrita</b>';
    expect(fitsTelegramLimit(card)).toBe(false);
    const parts = splitTelegramText(card);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT_LENGTH);
      expect(part).not.toMatch(DANGLING_ENTITY);
      expect(part).not.toMatch(DANGLING_TAG);
    }
    // Line-based split: exact rejoin, every row whole in exactly one part.
    expect(parts.join('\n')).toBe(card);
    for (const token of [
      'Cliente 0 Hernández',
      'Cliente 399 Hernández',
      '0414-5460657',
      'ABC-123',
      '$8.00 USD',
      '2026-09-07',
      'maxnet050',
    ]) {
      const hits = parts.filter((part) => part.includes(token));
      expect(hits, token).toHaveLength(1);
    }
  });

  it('hard-cuts a single over-long line only at entity/tag-safe boundaries', () => {
    const line = `prefix-${'x'.repeat(TELEGRAM_MAX_TEXT_LENGTH - 20)} &amp; tail <b>bold</b> end`;
    expect(line.includes('\n')).toBe(false);
    const parts = splitTelegramText(line);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT_LENGTH);
      expect(part).not.toMatch(DANGLING_ENTITY);
      expect(part).not.toMatch(DANGLING_TAG);
    }
    // Verbatim preservation: chunks rejoin to the exact line.
    expect(parts.join('')).toBe(line);
    expect(parts.join('')).toContain('&amp;');
    expect(parts.join('')).toContain('<b>bold</b>');
  });
});

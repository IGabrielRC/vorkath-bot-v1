/**
 * Contextual UNKNOWN (never bare): the global fallback keeps its stable
 * prefix and appends WHAT was expected — the open sale draft's missing
 * fields, or the available sections otherwise.
 */

import { describe, expect, it } from 'vitest';
import { UNKNOWN_TEXT } from '../src/telegram/webhook';
import {
  GABRIEL,
  GROUP_CHAT_ID,
  createTwinWorld,
  sendText,
} from './helpers/twinHarness';

describe('contextual UNKNOWN (never bare)', () => {
  it('names the available sections when nothing is expected', async () => {
    const world = await createTwinWorld();
    try {
      await sendText(world, GABRIEL, 'blorpt zzz qqq');
      const last = world.client.texts().at(-1) ?? '';
      expect(last).toContain(UNKNOWN_TEXT);
      expect(last).not.toBe(UNKNOWN_TEXT);
      for (const section of ['Operar', 'Buscar', 'Vencidos', 'Inventario', 'Caja', 'Más']) {
        expect(last).toContain(section);
      }
    } finally {
      await world.app.close();
    }
  });

  it('shows pending-management feedback when an unknown intent hits an open sale draft', async () => {
    const world = await createTwinWorld({ sale: true });
    try {
      expect(world.saleDrafts).toBeDefined();
      world.saleDrafts?.create({ chatId: GROUP_CHAT_ID, userId: GABRIEL }, 'Gabriel');
      await sendText(world, GABRIEL, 'blorpt zzz qqq');
      const last = world.client.texts().at(-1) ?? '';
      // The sale scope answers first, on the SAME card: the unknown
      // intent never cancels, never opens a second card, and is never
      // silent — it shows the pending-management notice (draft intact).
      expect(last).not.toBe(UNKNOWN_TEXT);
      expect(last).toContain('Tienes una gestión pendiente');
      expect(last).toContain('Continúa o cancela');
      expect(world.saleDrafts?.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })).toBeDefined();
    } finally {
      await world.app.close();
    }
  });
});

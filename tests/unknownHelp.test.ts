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

  it('names the expected sale field when a sale draft is open', async () => {
    const world = await createTwinWorld({ sale: true });
    try {
      expect(world.saleDrafts).toBeDefined();
      world.saleDrafts?.create({ chatId: GROUP_CHAT_ID, userId: GABRIEL }, 'Gabriel');
      await sendText(world, GABRIEL, 'blorpt zzz qqq');
      const last = world.client.texts().at(-1) ?? '';
      // The sale scope answers first (draft intact, fields named) —
      // still never a bare global fallback.
      expect(last).not.toBe(UNKNOWN_TEXT);
      expect(last).toContain('sigo esperando');
      // A fresh draft is missing the service first.
      expect(last).toContain('el servicio');
      expect(world.saleDrafts?.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })).toBeDefined();
    } finally {
      await world.app.close();
    }
  });
});

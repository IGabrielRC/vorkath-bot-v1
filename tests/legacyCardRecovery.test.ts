/**
 * Legacy sendLabeled hardening (transversal gaps 1+2+4): the non-sale
 * path (search/Home/expired/inventory/cash/more) shares the sale path's
 * recovery — stale keyboards die on foreground loss, and a dead tapped
 * message recovers into an adopted replacement card with draft/state
 * intact (never a throw, never lost state).
 */

import { describe, expect, it } from 'vitest';
import {
  GABRIEL,
  GROUP_CHAT_ID,
  createTwinWorld,
  sendText,
  tapButton,
  tapCallback,
} from './helpers/twinHarness';

describe('legacy card recovery (sendLabeled)', () => {
  it('deactivates the prior Home keyboard when a foreground card lands', async () => {
    const world = await createTwinWorld();
    try {
      await sendText(world, GABRIEL, '/start');
      const home = world.interactions.snapshot().find((entry) => entry.type === 'HOME');
      const homeCard = home?.state['cardMessageId'];
      expect(typeof homeCard).toBe('number');

      await tapButton(world, GABRIEL, '⏰VENCIDOS');
      const markups = world.client.markupEdits();
      expect(markups.some((edit) => edit.messageId === homeCard)).toBe(true);
    } finally {
      await world.app.close();
    }
  });

  it('card-lost edit recovers into an adopted replacement; draft/state survives', async () => {
    const world = await createTwinWorld();
    try {
      await tapButton(world, GABRIEL, '⚡OPERAR');
      expect(world.drafts.isOpen({ chatId: GROUP_CHAT_ID, userId: GABRIEL })).toBe(true);
      const operation = world.interactions
        .snapshot()
        .find((entry) => entry.type === 'OPERATION');
      expect(operation?.status).toBe('PENDING');

      const data = world.client.findButton('✏️Corregir');
      expect(data).toBeDefined();
      // The tapped message was deleted out-of-band (user deleted it).
      world.client.failNextEditWith = new Error('message to edit not found');
      const response = await tapCallback(world, GABRIEL, data ?? '');
      expect(response.statusCode).toBe(200);

      // Replacement card sent (fresh send, keyboard kept), nothing thrown.
      const lastSend = [...world.client.sent].reverse().find((entry) => entry.kind === 'send');
      expect(lastSend).toBeDefined();
      const draftStillOpen = world.drafts.isOpen({ chatId: GROUP_CHAT_ID, userId: GABRIEL });
      expect(draftStillOpen).toBe(true);
      // The replacement card is adopted onto a live interaction.
      const adopted = world.interactions
        .snapshot()
        .some((entry) => typeof entry.state['cardMessageId'] === 'number');
      expect(adopted).toBe(true);
    } finally {
      await world.app.close();
    }
  });

  it('identical re-render is success without a duplicate card', async () => {
    const world = await createTwinWorld();
    try {
      await tapButton(world, GABRIEL, '⚡OPERAR');
      const data = world.client.findButton('✏️Corregir');
      expect(data).toBeDefined();
      world.client.failNextEditWith = new Error('message is not modified');
      const sendsBefore = world.client.sent.filter((entry) => entry.kind === 'send').length;
      const response = await tapCallback(world, GABRIEL, data ?? '');
      expect(response.statusCode).toBe(200);
      const sendsAfter = world.client.sent.filter((entry) => entry.kind === 'send').length;
      expect(sendsAfter).toBe(sendsBefore);
    } finally {
      await world.app.close();
    }
  });
});

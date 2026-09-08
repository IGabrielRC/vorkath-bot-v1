/**
 * Proves the shared twin harness (tests/helpers/twinHarness.ts) is the
 * going-forward E2E standard: ONE matrix covers phrase→layer→tool/spy +
 * Gemini-call counting for the four placeholder sections, plus an L3
 * counting proof. Future twins copy this file's shape — new helpers go
 * in the harness, never in per-file scaffolding.
 */

import { describe, expect, it, vi } from 'vitest';
import { UNKNOWN_TEXT } from '../src/telegram/webhook';
import {
  GABRIEL,
  createTwinWorld,
  geminiCalls,
  phraseLayer,
  sendText,
  tapButton,
} from './helpers/twinHarness';

interface TwinRow {
  section: string;
  button: string;
  phrase: string;
  tool?: 'getExpiredAccounts' | 'getInventorySummary';
}

const ROWS: TwinRow[] = [
  {
    section: 'vencidos',
    button: '⏰VENCIDOS',
    phrase: 'DIME CUÁLES ESTÁN VENCIDOS',
    tool: 'getExpiredAccounts',
  },
  {
    section: 'inventario',
    button: '📦INVENTARIO',
    phrase: 'CÓMO ESTÁ EL INVENTARIO',
    tool: 'getInventorySummary',
  },
  { section: 'caja', button: '💰CAJA', phrase: '¿cómo está la caja?' },
  { section: 'mas', button: '⋯MÁS', phrase: '¿qué más puedo hacer?' },
];

describe('shared harness: button↔NL twin matrix (phrase→layer→tool/spy + Gemini counting)', () => {
  for (const row of ROWS) {
    it(`${row.section}: NL phrase and button converge on the same reply with zero Gemini`, async () => {
      const world = await createTwinWorld();
      try {
        expect(await phraseLayer(world, GABRIEL, row.phrase)).toBe('L2');
        const spy = row.tool !== undefined ? vi.spyOn(world.repos, row.tool) : undefined;
        const before = geminiCalls(world);
        await sendText(world, GABRIEL, row.phrase);
        const nlText = world.client.texts().at(-1) ?? '';
        expect(nlText.length).toBeGreaterThan(0);
        if (spy !== undefined) {
          expect(spy).toHaveBeenCalledTimes(1);
        }
        await tapButton(world, GABRIEL, row.button);
        const buttonText = world.client.texts().at(-1) ?? '';
        expect(buttonText).toBe(nlText);
        if (spy !== undefined) {
          expect(spy).toHaveBeenCalledTimes(2);
        }
        expect(geminiCalls(world) - before).toBe(0);
      } finally {
        await world.app.close();
      }
    });
  }

  it('proves Gemini counting: L3 semantics cost exactly one call', async () => {
    const world = await createTwinWorld();
    try {
      const before = geminiCalls(world);
      await sendText(world, GABRIEL, 'blorpt zzz qqq');
      expect(geminiCalls(world) - before).toBe(1);
      expect(world.client.texts().at(-1) ?? '').toContain(UNKNOWN_TEXT);
    } finally {
      await world.app.close();
    }
  });
});

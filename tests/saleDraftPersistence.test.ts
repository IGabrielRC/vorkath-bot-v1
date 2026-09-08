/**
 * NewSaleDraftStore persistence (CRITICAL): real sale drafts survive
 * EasyPanel redeploys via the same atomic tmp+rename snapshot pattern
 * as DraftEngine/InteractionStore, restored at boot and in persistAll.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NewSaleDraftStore, applySalePatch } from '../src/sale/newSaleDraft';

const OWNER = { chatId: -1005550001, userId: 1057242322, name: 'Gabriel' };

describe('NewSaleDraftStore file persistence', () => {
  it('round-trips an open draft through saveToFile/loadFromFile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vokath-sale-persist-'));
    const filePath = join(dir, 'sale-drafts-state.json');
    const store = new NewSaleDraftStore();
    const { draft } = store.create(OWNER, 'Gabriel');
    const patched = applySalePatch(draft, { phone: '0414-5460657', requestedMonths: 2 }).draft;
    store.save(patched);
    await store.saveToFile(filePath);

    const raw = JSON.parse(readFileSync(filePath, 'utf8') as string) as unknown[];
    expect(Array.isArray(raw)).toBe(true);

    const restored = new NewSaleDraftStore();
    await restored.loadFromFile(filePath);
    const found = restored.get(OWNER);
    expect(found?.operationId).toBe(patched.operationId);
    expect(found?.phone).toBe('0414-5460657');
    expect(found?.duration.requestedMonths).toBe(2);
  });

  it('starts empty on a missing file (first boot)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vokath-sale-missing-'));
    const store = new NewSaleDraftStore();
    await store.loadFromFile(join(dir, 'no-such-file.json'));
    expect(store.snapshot()).toHaveLength(0);
  });

  it('ignores a corrupt (non-array) snapshot instead of crashing boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vokath-sale-corrupt-'));
    const filePath = join(dir, 'sale-drafts-state.json');
    writeFileSync(filePath, JSON.stringify({ not: 'an-array' }), 'utf8');
    const store = new NewSaleDraftStore();
    await store.loadFromFile(filePath);
    expect(store.snapshot()).toHaveLength(0);
  });

  it('restores DRAFT-only (confirmed headers do not resurrect as open)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vokath-sale-status-'));
    const filePath = join(dir, 'sale-drafts-state.json');
    const store = new NewSaleDraftStore();
    const { draft } = store.create(OWNER, 'Gabriel');
    store.save(draft);
    store.confirmSale(OWNER);
    await store.saveToFile(filePath);

    const restored = new NewSaleDraftStore();
    await restored.loadFromFile(filePath);
    expect(restored.get(OWNER)).toBeUndefined();
  });
});

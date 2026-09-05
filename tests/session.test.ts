import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_SEEN_UPDATE_IDS, SessionStore } from '../src/session/store';

describe('SessionStore', () => {
  it('isolates sessions and drafts per user', () => {
    const store = new SessionStore();
    store.touchSession(111, 1);
    store.touchSession(222, 2);
    store.setDraft({
      userId: 111,
      status: 'open',
      data: { months: 1 },
      updatedAt: new Date().toISOString(),
    });

    expect(store.getSession(111)?.lastUpdateId).toBe(1);
    expect(store.getSession(222)?.lastUpdateId).toBe(2);
    expect(store.getDraft(111)?.data).toEqual({ months: 1 });
    expect(store.getDraft(222)).toBeUndefined();
  });

  it('dedupes redelivered update_ids', () => {
    const store = new SessionStore();
    expect(store.markUpdateSeen(42)).toBe(false);
    expect(store.markUpdateSeen(42)).toBe(true);
    expect(store.markUpdateSeen(43)).toBe(false);
  });

  it('bounds the dedupe ring to the last 1000 update_ids', () => {
    const store = new SessionStore();
    for (let id = 1; id <= MAX_SEEN_UPDATE_IDS + 10; id += 1) {
      store.markUpdateSeen(id);
    }
    // The oldest ids were evicted, so they read as unseen again.
    expect(store.markUpdateSeen(1)).toBe(false);
    // Recent ids are still remembered.
    expect(store.markUpdateSeen(MAX_SEEN_UPDATE_IDS + 10)).toBe(true);
  });

  it('persists atomically and reloads state (tmp+rename, no partial writes)', async () => {    const store = new SessionStore();
    store.touchSession(111, 7);
    store.setDraft({
      userId: 111,
      status: 'open',
      data: { months: 2 },
      updatedAt: new Date().toISOString(),
    });

    const filePath = join(tmpdir(), `vokath-test-${process.pid}-${Date.now()}.json`);
    await store.persistTo(filePath);

    const restored = new SessionStore();
    await restored.loadFrom(filePath);
    expect(restored.getSession(111)?.lastUpdateId).toBe(7);
    expect(restored.getDraft(111)?.data).toEqual({ months: 2 });

    await fs.unlink(filePath);
  });

  it('writes tmp alongside the target (same device, no EXDEV) with no strays left', async () => {
    const dir = join(tmpdir(), `vokath-vol-${process.pid}-${Date.now()}`);
    const filePath = join(dir, 'nested', 'mock-state.json');
    const store = new SessionStore();
    store.touchSession(555, 9);
    await store.persistTo(filePath);

    const entries = await fs.readdir(join(dir, 'nested'));
    expect(entries).toEqual(['mock-state.json']);

    const restored = new SessionStore();
    await restored.loadFrom(filePath);
    expect(restored.getSession(555)?.lastUpdateId).toBe(9);

    await fs.rm(dir, { recursive: true, force: true });
  });
});

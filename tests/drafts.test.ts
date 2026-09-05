import { describe, expect, it } from 'vitest';
import {
  DRAFT_CANCEL_TEXT,
  DRAFT_CONFIRM_TEXT,
  DraftEngine,
} from '../src/drafts/engine';

describe('DraftEngine lifecycle (RED: per-user, no-expiry demo)', () => {
  it('creates → reads → corrects 1→2 months → confirms with the exact MOCK text', () => {
    const engine = new DraftEngine();
    const created = engine.create(111, { months: 1 });
    expect(created.status).toBe('open');
    expect(engine.get(111)?.months).toBe(1);

    engine.update(111, { months: 2 });
    expect(engine.get(111)?.months).toBe(2);

    const result = engine.confirm(111);
    expect(result.text).toBe(DRAFT_CONFIRM_TEXT);
    expect(DRAFT_CONFIRM_TEXT).toBe('✅ Operación MOCK confirmada');
    expect(engine.get(111)?.status).toBe('confirmed');
  });

  it('cancels with the exact cancel text and zero side-effects', () => {
    const engine = new DraftEngine();
    engine.create(111, { months: 1 });
    const result = engine.cancel(111);
    expect(result.text).toBe(DRAFT_CANCEL_TEXT);
    expect(DRAFT_CANCEL_TEXT).toBe('❌ Operación cancelada');
    expect(engine.get(111)?.status).toBe('cancelled');
  });

  it('isolates Gabriel and Edward drafts (per-user, no globals)', () => {
    const engine = new DraftEngine();
    engine.create(111, { months: 1 });
    engine.create(222, { months: 2 });
    engine.update(111, { months: 5 });
    expect(engine.get(111)?.months).toBe(5);
    expect(engine.get(222)?.months).toBe(2);
  });

  it('confirm/cancel on a missing draft is a safe no-op', () => {
    const engine = new DraftEngine();
    expect(engine.confirm(999).ok).toBe(false);
    expect(engine.cancel(999).ok).toBe(false);
  });
});

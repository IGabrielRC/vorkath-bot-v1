/**
 * Per-user draft engine (demo, no-expiry). Drafts hold MOCK operation
 * data only — confirm/cancel reply with the exact spec texts and
 * perform zero real side-effects.
 */

export const DRAFT_CONFIRM_TEXT = '✅ Operación MOCK confirmada';
export const DRAFT_CANCEL_TEXT = '❌ Operación cancelada';

export type DraftStatus = 'open' | 'confirmed' | 'cancelled';

export interface Draft {
  userId: number;
  status: DraftStatus;
  months: number;
  updatedAt: string;
}

export interface DraftResult {
  ok: boolean;
  text: string;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Per-user Map — never a shared global draft. One open draft per user
 * (demo scope); concurrent owners stay isolated by userId key.
 */
export class DraftEngine {
  private readonly drafts = new Map<number, Draft>();

  create(userId: number, opts?: { months?: number }): Draft {
    const draft: Draft = {
      userId,
      status: 'open',
      months: opts?.months ?? 1,
      updatedAt: now(),
    };
    this.drafts.set(userId, draft);
    return draft;
  }

  get(userId: number): Draft | undefined {
    return this.drafts.get(userId);
  }

  update(userId: number, patch: { months?: number }): Draft | undefined {
    const current = this.drafts.get(userId);
    if (current === undefined || current.status !== 'open') {
      return undefined;
    }
    const next: Draft = {
      ...current,
      ...(patch.months !== undefined ? { months: patch.months } : {}),
      updatedAt: now(),
    };
    this.drafts.set(userId, next);
    return next;
  }

  confirm(userId: number): DraftResult {
    const current = this.drafts.get(userId);
    if (current === undefined || current.status !== 'open') {
      return { ok: false, text: 'Sin borrador abierto que confirmar.' };
    }
    this.drafts.set(userId, { ...current, status: 'confirmed', updatedAt: now() });
    return { ok: true, text: DRAFT_CONFIRM_TEXT };
  }

  cancel(userId: number): DraftResult {
    const current = this.drafts.get(userId);
    if (current === undefined || current.status !== 'open') {
      return { ok: false, text: 'Sin borrador abierto que cancelar.' };
    }
    this.drafts.set(userId, { ...current, status: 'cancelled', updatedAt: now() });
    return { ok: true, text: DRAFT_CANCEL_TEXT };
  }
}

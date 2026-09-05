import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Per-actor draft engine (demo, no-expiry). Drafts hold MOCK operation
 * data only — confirm/cancel reply with the exact spec texts and
 * perform zero real side-effects.
 *
 * Shared-group identity: drafts are keyed by (chatId, actorTelegramUserId).
 * The visible context is shared (one group), but each operator owns an
 * independent draft — corrections/confirm/cancel resolve strictly through
 * the actor's own key and never leak across actors.
 *
 * Drafts NEVER expire: no TTL anywhere in this module. Durability comes
 * from `saveToFile`/`loadFromFile` (atomic tmp-file + rename, same-device
 * tmp so rename() never hits EXDEV), called best-effort by the webhook
 * after every mutation and once at boot.
 */

export const DRAFT_CONFIRM_TEXT = '✅ Operación MOCK confirmada';
export const DRAFT_CANCEL_TEXT = '❌ Operación cancelada';

export type DraftStatus = 'open' | 'confirmed' | 'cancelled';

export interface Draft {
  chatId: number;
  userId: number;
  ownerName?: string;
  status: DraftStatus;
  months: number;
  updatedAt: string;
}

export interface DraftResult {
  ok: boolean;
  text: string;
}

/**
 * Draft owner. Plain numbers are accepted anywhere a DraftOwner is
 * expected for backwards compatibility (legacy private-chat callers):
 * they mean `{ chatId: 0, userId: <number> }`.
 */
export interface DraftOwner {
  chatId: number;
  userId: number;
  name?: string;
}

export type DraftKey = DraftOwner | number;

export interface DraftCreateOpts {
  months?: number;
  ownerName?: string;
}

function now(): string {
  return new Date().toISOString();
}

function keyOf(owner: DraftKey): string {
  if (typeof owner === 'number') {
    return `0:${owner}`;
  }
  return `${owner.chatId}:${owner.userId}`;
}

function normalizeOwner(owner: DraftKey, opts?: DraftCreateOpts): {
  chatId: number;
  userId: number;
  ownerName?: string;
} {
  if (typeof owner === 'number') {
    return opts?.ownerName !== undefined
      ? { chatId: 0, userId: owner, ownerName: opts.ownerName }
      : { chatId: 0, userId: owner };
  }
  const name = opts?.ownerName ?? owner.name;
  return name !== undefined
    ? { chatId: owner.chatId, userId: owner.userId, ownerName: name }
    : { chatId: owner.chatId, userId: owner.userId };
}

/**
 * Per-actor Map keyed by `chatId:userId` — never a shared global draft.
 * One open draft per actor (demo scope); concurrent owners stay isolated
 * by key. Starting a new operation while one is open RESUMES it (the
 * in-progress months are never wiped by a duplicate create).
 */
export class DraftEngine {
  private readonly drafts = new Map<string, Draft>();

  create(owner: DraftKey, opts?: DraftCreateOpts): Draft {
    const key = keyOf(owner);
    const existing = this.drafts.get(key);
    if (existing !== undefined && existing.status === 'open') {
      // Resume — never wipe in-progress state on a duplicate start.
      const normalized = normalizeOwner(owner, opts);
      if (normalized.ownerName !== undefined && normalized.ownerName !== existing.ownerName) {
        const renamed: Draft = {
          ...existing,
          ownerName: normalized.ownerName,
          updatedAt: now(),
        };
        this.drafts.set(key, renamed);
        return renamed;
      }
      return existing;
    }
    const normalized = normalizeOwner(owner, opts);
    const draft: Draft = {
      chatId: normalized.chatId,
      userId: normalized.userId,
      status: 'open',
      months: opts?.months ?? 1,
      updatedAt: now(),
    };
    if (normalized.ownerName !== undefined) {
      draft.ownerName = normalized.ownerName;
    }
    this.drafts.set(key, draft);
    return draft;
  }

  get(owner: DraftKey): Draft | undefined {
    return this.drafts.get(keyOf(owner));
  }

  /** True when this actor has an open draft (used to detect resume). */
  isOpen(owner: DraftKey): boolean {
    return this.drafts.get(keyOf(owner))?.status === 'open';
  }

  /**
   * Finds another actor's OPEN draft in the same chat — the ownership
   * guard. When the requester has no open draft but a peer does, the
   * caller must reply with the ownership warning instead of touching
   * the peer's draft.
   */
  findOtherOpenDraft(chatId: number, excludeUserId: number): Draft | undefined {
    for (const draft of this.drafts.values()) {
      if (draft.chatId === chatId && draft.userId !== excludeUserId && draft.status === 'open') {
        return draft;
      }
    }
    return undefined;
  }

  update(owner: DraftKey, patch: { months?: number }): Draft | undefined {
    const key = keyOf(owner);
    const current = this.drafts.get(key);
    if (current === undefined || current.status !== 'open') {
      return undefined;
    }
    const next: Draft = {
      ...current,
      ...(patch.months !== undefined ? { months: patch.months } : {}),
      updatedAt: now(),
    };
    this.drafts.set(key, next);
    return next;
  }

  confirm(owner: DraftKey): DraftResult {
    const key = keyOf(owner);
    const current = this.drafts.get(key);
    if (current === undefined || current.status !== 'open') {
      return { ok: false, text: 'Sin borrador abierto que confirmar.' };
    }
    this.drafts.set(key, { ...current, status: 'confirmed', updatedAt: now() });
    return { ok: true, text: DRAFT_CONFIRM_TEXT };
  }

  cancel(owner: DraftKey): DraftResult {
    const key = keyOf(owner);
    const current = this.drafts.get(key);
    if (current === undefined || current.status !== 'open') {
      return { ok: false, text: 'Sin borrador abierto que cancelar.' };
    }
    this.drafts.set(key, { ...current, status: 'cancelled', updatedAt: now() });
    return { ok: true, text: DRAFT_CANCEL_TEXT };
  }

  /** Full in-memory snapshot (pure — for persistence and tests). */
  snapshot(): Draft[] {
    return [...this.drafts.values()];
  }

  /** Restores a snapshot, replacing all in-memory state. */
  restore(drafts: Draft[]): void {
    this.drafts.clear();
    for (const draft of drafts) {
      this.drafts.set(`${draft.chatId}:${draft.userId}`, { ...draft });
    }
  }

  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * Atomic persist (tmp + rename). The queue self-heals: a failed write
   * rejects only its own caller and never poisons later saves, so drafts
   * are never silently lost after one bad write.
   */
  saveToFile(filePath: string): Promise<void> {
    const run = async (): Promise<void> => {
      const dir = dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      const tmpPath = join(dir, `.vokath-drafts-${process.pid}-${Date.now()}.tmp`);
      try {
        await fs.writeFile(tmpPath, JSON.stringify(this.snapshot(), null, 2), 'utf8');
        await fs.rename(tmpPath, filePath);
      } catch (error) {
        await fs.unlink(tmpPath).catch(() => undefined);
        throw error;
      }
    };
    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }

  /** Best-effort load: missing file means first boot — start empty. */
  async loadFromFile(filePath: string): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return;
    }
    const valid = (parsed as Draft[]).filter(
      (draft) =>
        typeof draft?.chatId === 'number' &&
        typeof draft?.userId === 'number' &&
        (draft.status === 'open' || draft.status === 'confirmed' || draft.status === 'cancelled') &&
        typeof draft.months === 'number',
    );
    this.restore(valid);
  }
}

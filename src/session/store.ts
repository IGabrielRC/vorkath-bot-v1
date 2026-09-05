import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SessionState {
  userId: number;
  /** Shared-group chat this session belongs to (0 = legacy private-chat key). */
  chatId?: number;
  lastUpdateId?: number;
  updatedAt: string;
}

export interface DraftState {
  userId: number;
  status: 'open' | 'confirmed' | 'cancelled';
  data: Record<string, unknown>;
  updatedAt: string;
}

interface PersistedState {
  sessions: SessionState[];
  drafts: DraftState[];
}

/** Maximum update_ids remembered for Telegram redelivery dedupe. */
export const MAX_SEEN_UPDATE_IDS = 1000;

/**
 * Per-actor in-memory store. Sessions are keyed by (chatId, userId) so
 * the two owners sharing ONE group never collide; legacy single-arg
 * callers keep working against chatId 0. Drafts stay keyed by userId
 * for the legacy map (the live draft engine keys by chat+actor).
 * update_id redelivery is deduplicated through a bounded ring of the
 * last 1000 ids.
 *
 * Persistence is an atomic tmp-file + rename behind a promise queue, so
 * concurrent saves from the two owners cannot interleave partial writes.
 * The queue self-heals: a failed write rejects only its own caller and
 * never poisons later saves.
 */
export class SessionStore {
  readonly sessions = new Map<string, SessionState>();
  readonly drafts = new Map<number, DraftState>();

  private seenUpdateIds = new Set<number>();
  private seenOrder: number[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  static sessionKey(chatId: number, userId: number): string {
    return `${chatId}:${userId}`;
  }

  /** Returns true when this update_id was already processed (redelivery). */
  markUpdateSeen(updateId: number): boolean {
    if (this.seenUpdateIds.has(updateId)) {
      return true;
    }
    this.seenUpdateIds.add(updateId);
    this.seenOrder.push(updateId);
    while (this.seenOrder.length > MAX_SEEN_UPDATE_IDS) {
      const oldest = this.seenOrder.shift();
      if (oldest !== undefined) {
        this.seenUpdateIds.delete(oldest);
      }
    }
    return false;
  }

  getSession(userId: number, chatId = 0): SessionState | undefined {
    return this.sessions.get(SessionStore.sessionKey(chatId, userId));
  }

  touchSession(userId: number, updateId?: number, chatId = 0): SessionState {
    const key = SessionStore.sessionKey(chatId, userId);
    const session: SessionState = {
      userId,
      chatId,
      updatedAt: new Date().toISOString(),
    };
    const resolvedUpdateId = updateId ?? this.sessions.get(key)?.lastUpdateId;
    if (resolvedUpdateId !== undefined) {
      session.lastUpdateId = resolvedUpdateId;
    }
    this.sessions.set(key, session);
    return session;
  }

  getDraft(userId: number): DraftState | undefined {
    return this.drafts.get(userId);
  }

  setDraft(draft: DraftState): void {
    this.drafts.set(draft.userId, draft);
  }

  /** Atomic persist: write to tmp file in the same directory, then rename. */
  persistTo(filePath: string): Promise<void> {
    // Both handlers run the write: a prior failure never poisons the
    // queue, and the current write's own failure still rejects its caller.
    const run = (): Promise<void> => this.writeAtomically(filePath);
    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }

  async loadFrom(filePath: string): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as PersistedState;
    this.sessions.clear();
    this.drafts.clear();
    for (const session of parsed.sessions ?? []) {
      // Legacy snapshots lack chatId — they land on the chatId-0 key,
      // which is exactly what single-arg getSession() reads.
      this.sessions.set(SessionStore.sessionKey(session.chatId ?? 0, session.userId), session);
    }
    for (const draft of parsed.drafts ?? []) {
      this.drafts.set(draft.userId, draft);
    }
  }

  private async writeAtomically(filePath: string): Promise<void> {
    const payload: PersistedState = {
      sessions: [...this.sessions.values()],
      drafts: [...this.drafts.values()],
    };
    const dir = dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    // Tmp lives alongside the target (same device) so rename() never
    // hits EXDEV — os.tmpdir() may sit on a different filesystem than
    // the /data volume. Dot-prefix keeps stray tmps hidden on crash.
    const tmpPath = join(dir, `.vokath-state-${process.pid}-${Date.now()}.tmp`);
    try {
      await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }
}

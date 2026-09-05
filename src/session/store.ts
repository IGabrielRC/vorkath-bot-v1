import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SessionState {
  userId: number;
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
 * Per-user in-memory store. sessions[userId]/drafts[userId] are isolated
 * Maps — never globals shared across users. update_id redelivery is
 * deduplicated through a bounded ring of the last 1000 ids.
 *
 * Persistence is an atomic tmp-file + rename behind a promise queue, so
 * concurrent saves from the two owners cannot interleave partial writes.
 */
export class SessionStore {
  readonly sessions = new Map<number, SessionState>();
  readonly drafts = new Map<number, DraftState>();

  private seenUpdateIds = new Set<number>();
  private seenOrder: number[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

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

  getSession(userId: number): SessionState | undefined {
    return this.sessions.get(userId);
  }

  touchSession(userId: number, updateId?: number): SessionState {
    const session: SessionState = {
      userId,
      updatedAt: new Date().toISOString(),
    };
    const resolvedUpdateId = updateId ?? this.sessions.get(userId)?.lastUpdateId;
    if (resolvedUpdateId !== undefined) {
      session.lastUpdateId = resolvedUpdateId;
    }
    this.sessions.set(userId, session);
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
    this.writeQueue = this.writeQueue.then(() => this.writeAtomically(filePath));
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
      this.sessions.set(session.userId, session);
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

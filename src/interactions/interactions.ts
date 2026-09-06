import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  OperatorProfileStore,
  sanitizeOwnerLabel,
  type ChatMemberFetcher,
  type OperatorProfile,
  type TelegramFrom,
} from '../operators/operatorProfiles';

/**
 * Per-interaction ownership model (shared-group root-cause fix).
 *
 * Every interactive requirement gets an Interaction: a unique id plus the
 * (chatId, ownerTelegramUserId) pair that owns it. The owner ALWAYS comes
 * from `message.from.id` / `callback_query.from.id` — never inferred from
 * `chat.id` alone. Minimal scope is chatId + actorTelegramUserId, plus the
 * interactionId whenever one exists.
 *
 * All per-actor conversational state (active interaction, pending input,
 * draft linkage, navigation, selected customer/account, search
 * query/offset, confirmation, correction context) lives keyed by
 * interactionId inside `state`, or is resolved through
 * (chatId, ownerTelegramUserId) — NEVER by chatId alone.
 *
 * Durability: `saveToFile`/`loadFromFile` (atomic tmp-file + rename,
 * same-device tmp so rename() never hits EXDEV), called best-effort by
 * the webhook after every mutation and once at boot. No Postgres.
 */

export type InteractionType =
  | 'HOME'
  | 'SEARCH'
  | 'OPERATION'
  | 'DRAFT'
  | 'INVENTORY'
  | 'EXPIRED'
  | 'CASH'
  | 'MORE'
  | 'ACCOUNT_LOOKUP'
  | 'CUSTOMER_LOOKUP';

export type InteractionStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED';

export interface Interaction {
  /** Short hex id (8 chars) — fits Telegram's 64-byte callback_data. */
  id: string;
  chatId: number;
  ownerTelegramUserId: number;
  ownerName?: string;
  /**
   * Forum topic this interaction was created in. Undefined = created
   * outside forum mode (Mode A) or before topics existed — persistence
   * and old snapshots tolerate its absence.
   */
  messageThreadId?: number;
  type: InteractionType;
  status: InteractionStatus;
  /** Per-interaction context: search query/offset, view, draft linkage… */
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface InteractionCreateOpts {
  /** Injectable id for tests; production uses a random 8-hex id. */
  id?: string;
  ownerName?: string;
  /** Forum topic the interaction belongs to; undefined in Mode A. */
  messageThreadId?: number;
  state?: Record<string, unknown>;
}

function now(): string {
  return new Date().toISOString();
}

export function newInteractionId(): string {
  return randomBytes(4).toString('hex');
}

export class InteractionStore {
  private readonly interactions = new Map<string, Interaction>();
  /** chatId → (operator display name → telegram user id), for reply guards. */
  private readonly operatorNames = new Map<string, number>();
  /** chatId → (telegram user id → operator display name), for topic mismatch labels. */
  private readonly operatorNameById = new Map<string, string>();
  /**
   * Central OperatorProfile store: the ONE place names live. The two
   * legacy maps above stay as a reverse index (name → id for the
   * reply-ownership guard) fed from every profile upsert — never a
   * parallel source of truth for display names.
   */
  readonly profiles = new OperatorProfileStore();
  private writeQueue: Promise<void> = Promise.resolve();

  private static nameKey(chatId: number, name: string): string {
    return `${chatId}::${name.toLowerCase()}`;
  }

  private static idKey(chatId: number, userId: number): string {
    return `${chatId}::${userId}`;
  }

  /** Remembers an operator's display name so reply guards can resolve owners. */
  rememberOperator(chatId: number, userId: number, name: string | undefined): void {
    if (name !== undefined && name.trim() !== '') {
      // First-writer-wins: duplicate display names across people must not
      // let a same-name stranger steal the label's owner. Ownership stays
      // id-keyed everywhere; this map is only a best-effort hint.
      const key = InteractionStore.nameKey(chatId, name);
      if (!this.operatorNames.has(key)) {
        this.operatorNames.set(key, userId);
      }
      this.operatorNameById.set(InteractionStore.idKey(chatId, userId), name);
    }
    const profile = this.profiles.get(userId);
    if (profile !== undefined && profile.displayName.trim() !== '') {
      const profileKey = InteractionStore.nameKey(chatId, profile.displayName);
      if (!this.operatorNames.has(profileKey)) {
        this.operatorNames.set(profileKey, userId);
      }
    }
  }

  /**
   * Upserts the OperatorProfile from live Telegram `from` fields
   * (message AND callback_query.from). First touch creates it; later
   * touches refresh it when Telegram data changed. Also feeds the
   * reply-guard reverse index so renamed operators stay resolvable.
   */
  upsertOperatorProfile(chatId: number, from: TelegramFrom): OperatorProfile | undefined {
    const profile = this.profiles.upsert(from);
    if (profile !== undefined) {
      const key = InteractionStore.nameKey(chatId, profile.displayName);
      if (!this.operatorNames.has(key)) {
        this.operatorNames.set(key, profile.telegramUserId);
      }
      this.operatorNameById.set(
        InteractionStore.idKey(chatId, profile.telegramUserId),
        profile.displayName,
      );
    }
    return profile;
  }

  /** Latest OperatorProfile for this user id, if any. */
  getOperatorProfile(userId: number): OperatorProfile | undefined {
    return this.profiles.get(userId);
  }

  resolveUserIdByName(chatId: number, name: string): number | undefined {
    return this.operatorNames.get(InteractionStore.nameKey(chatId, name));
  }

  /** Latest remembered display name for this operator, if any. */
  resolveNameByUserId(chatId: number, userId: number): string | undefined {
    return this.profiles.get(userId)?.displayName ?? this.operatorNameById.get(InteractionStore.idKey(chatId, userId));
  }

  /**
   * Owner display name for rejection/ownership messages naming ANOTHER
   * operator. Resolution order: OperatorProfile store → live `from`
   * fields → optional member `fetcher` (store-miss only, then persisted)
   * → remembered per-chat names → bare `Usuario`. Never empty, never a
   * numeric id. Security stays id-keyed everywhere; this only feeds UX
   * labels. Same-name strangers can't steal labels: every fallback here
   * is keyed by the owner's numeric id (first-writer-wins on the reverse
   * index is only a reply-guard hint, never a display source).
   */
  async resolveOwnerDisplayName(
    chatId: number,
    userId: number,
    opts?: { from?: TelegramFrom; fetcher?: ChatMemberFetcher; storedFallback?: string },
  ): Promise<string> {
    const stored = this.profiles.get(userId)?.displayName;
    const cleanStored = sanitizeOwnerLabel(stored);
    if (cleanStored !== undefined && opts?.from === undefined) {
      // Store hit: pure cache, the fetcher never fires on this path.
      return cleanStored;
    }
    const resolved = await this.profiles.resolveWithMemberFallback(
      userId,
      opts?.from,
      opts?.fetcher,
    );
    if (resolved !== 'Usuario') {
      return resolved;
    }
    if (cleanStored !== undefined) {
      return cleanStored;
    }
    const remembered = sanitizeOwnerLabel(
      this.operatorNameById.get(InteractionStore.idKey(chatId, userId)),
    );
    if (remembered !== undefined) {
      return remembered;
    }
    return sanitizeOwnerLabel(opts?.storedFallback) ?? resolved;
  }

  /**
   * Sync variant for sync-only rejection paths (draft/toast guards):
   * profile store → remembered per-chat names → sanitized stored label.
   * No network ever — the async member fallback lives only on the
   * topic-guard path (store-miss only).
   */
  resolveOwnerLabelSync(
    chatId: number,
    userId: number,
    storedFallback?: string,
  ): string | undefined {
    return (
      sanitizeOwnerLabel(this.profiles.get(userId)?.displayName) ??
      sanitizeOwnerLabel(this.operatorNameById.get(InteractionStore.idKey(chatId, userId))) ??
      sanitizeOwnerLabel(storedFallback)
    );
  }

  create(
    chatId: number,
    ownerTelegramUserId: number,
    type: InteractionType,
    opts?: InteractionCreateOpts,
  ): Interaction {
    const interaction: Interaction = {
      id: opts?.id ?? newInteractionId(),
      chatId,
      ownerTelegramUserId,
      type,
      status: 'PENDING',
      state: { ...(opts?.state ?? {}) },
      createdAt: now(),
      updatedAt: now(),
    };
    if (opts?.ownerName !== undefined) {
      interaction.ownerName = opts.ownerName;
    }
    if (opts?.messageThreadId !== undefined) {
      interaction.messageThreadId = opts.messageThreadId;
    }
    this.interactions.set(interaction.id, interaction);
    this.rememberOperator(chatId, ownerTelegramUserId, opts?.ownerName);
    return interaction;
  }

  get(id: string): Interaction | undefined {
    return this.interactions.get(id);
  }

  /**
   * Latest PENDING interaction for this (chatId, owner) pair — the only
   * context a text message may consult. Never returns a peer's interaction.
   * In forum mode pass the sender's thread: only an interaction created
   * in that same thread is returned, so text/drafts/search/Gemini-context
   * never cross threads. Undefined threadId keeps Mode A behavior.
   */
  getActive(
    chatId: number,
    ownerTelegramUserId: number,
    messageThreadId?: number,
  ): Interaction | undefined {
    let active: Interaction | undefined;
    for (const interaction of this.interactions.values()) {
      if (
        interaction.chatId !== chatId ||
        interaction.ownerTelegramUserId !== ownerTelegramUserId ||
        interaction.status !== 'PENDING'
      ) {
        continue;
      }
      if (
        messageThreadId !== undefined &&
        interaction.messageThreadId !== undefined &&
        interaction.messageThreadId !== messageThreadId
      ) {
        continue;
      }
      if (active === undefined || interaction.updatedAt >= active.updatedAt) {
        active = interaction;
      }
    }
    return active;
  }

  touch(id: string, patch?: Record<string, unknown>): Interaction | undefined {
    const current = this.interactions.get(id);
    if (current === undefined) {
      return undefined;
    }
    const next: Interaction = {
      ...current,
      state: patch !== undefined ? { ...current.state, ...patch } : current.state,
      updatedAt: now(),
    };
    this.interactions.set(id, next);
    return next;
  }

  confirm(id: string): Interaction | undefined {
    const current = this.interactions.get(id);
    if (current === undefined || current.status !== 'PENDING') {
      return undefined;
    }
    const next: Interaction = { ...current, status: 'CONFIRMED', updatedAt: now() };
    this.interactions.set(id, next);
    return next;
  }

  cancel(id: string): Interaction | undefined {
    const current = this.interactions.get(id);
    if (current === undefined || current.status !== 'PENDING') {
      return undefined;
    }
    const next: Interaction = { ...current, status: 'CANCELLED', updatedAt: now() };
    this.interactions.set(id, next);
    return next;
  }

  /** Full in-memory snapshot (pure — for persistence and tests). */
  snapshot(): Interaction[] {
    return [...this.interactions.values()];
  }

  /** Restores a snapshot, replacing all in-memory state. */
  restore(interactions: Interaction[]): void {
    this.interactions.clear();
    for (const interaction of interactions) {
      this.interactions.set(interaction.id, { ...interaction });
      this.rememberOperator(
        interaction.chatId,
        interaction.ownerTelegramUserId,
        interaction.ownerName,
      );
    }
  }

  /**
   * Atomic persist (tmp + rename). The queue self-heals: a failed write
   * rejects only its own caller and never poisons later saves.
   */
  saveToFile(filePath: string): Promise<void> {
    const run = async (): Promise<void> => {
      const dir = dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      const tmpPath = join(dir, `.vokath-interactions-${process.pid}-${Date.now()}.tmp`);
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
    const valid = (parsed as Interaction[]).filter(
      (interaction) =>
        typeof interaction?.id === 'string' &&
        typeof interaction?.chatId === 'number' &&
        typeof interaction?.ownerTelegramUserId === 'number' &&
        (interaction.status === 'PENDING' ||
          interaction.status === 'CONFIRMED' ||
          interaction.status === 'CANCELLED'),
    );
    this.restore(valid);
  }

  /**
   * OperatorProfile persistence passthroughs (separate snapshot file,
   * same atomic pattern). Kept on this store so the webhook's
   * best-effort `persistAll` and boot restore each touch one object.
   */
  saveProfilesToFile(filePath: string): Promise<void> {
    return this.profiles.saveToFile(filePath);
  }

  async loadProfilesFromFile(filePath: string): Promise<void> {
    await this.profiles.loadFromFile(filePath);
  }
}

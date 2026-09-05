import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

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
  private writeQueue: Promise<void> = Promise.resolve();

  private static nameKey(chatId: number, name: string): string {
    return `${chatId}::${name.toLowerCase()}`;
  }

  /** Remembers an operator's display name so reply guards can resolve owners. */
  rememberOperator(chatId: number, userId: number, name: string | undefined): void {
    if (name === undefined || name.trim() === '') {
      return;
    }
    this.operatorNames.set(InteractionStore.nameKey(chatId, name), userId);
  }

  resolveUserIdByName(chatId: number, name: string): number | undefined {
    return this.operatorNames.get(InteractionStore.nameKey(chatId, name));
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
   */
  getActive(chatId: number, ownerTelegramUserId: number): Interaction | undefined {
    let active: Interaction | undefined;
    for (const interaction of this.interactions.values()) {
      if (
        interaction.chatId !== chatId ||
        interaction.ownerTelegramUserId !== ownerTelegramUserId ||
        interaction.status !== 'PENDING'
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
}

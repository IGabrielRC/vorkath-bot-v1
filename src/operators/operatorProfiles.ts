import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * OperatorProfile: automatic per-operator display identity.
 *
 * `telegramUserId` is the ONLY security/ownership key — every ownership
 * guard, draft key, and interaction owner compares numeric ids. Names are
 * UX only: they are rendered in labels, toasts, guides, and alerts, and
 * NEVER branch authorization logic.
 *
 * Profiles are upserted from Telegram `from` fields on every authorized
 * update (message AND callback_query.from): the first touch creates the
 * profile, later touches refresh it when Telegram data changed. No manual
 * name tables exist anywhere — a brand-new allowlisted user is auto-named
 * on first touch.
 *
 * Display chain (never empty): first_name + last_name → first_name →
 * @username → `Usuario <id>` (raw id only as last resort; diagnostics
 * may show it, normal UX never should need it).
 */

export interface TelegramFrom {
  id?: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface OperatorProfile {
  telegramUserId: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  displayName: string;
  updatedAt: string;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Central display-name builder. NEVER returns an empty string. Name parts
 * are trimmed; a blank first_name falls through to the next link instead
 * of rendering an empty `👤 Operador:` label.
 */
export function buildDisplayName(
  firstName: string | undefined,
  lastName: string | undefined,
  username: string | undefined,
  userId: number,
): string {
  const first = firstName?.trim() ?? '';
  const last = lastName?.trim() ?? '';
  const full = `${first} ${last}`.trim().replace(/\s+/g, ' ');
  if (full !== '') {
    return full;
  }
  const handle = username?.trim() ?? '';
  if (handle !== '') {
    return handle.startsWith('@') ? handle : `@${handle}`;
  }
  return `Usuario ${userId}`;
}

function sameParts(
  current: OperatorProfile,
  next: { firstName?: string | undefined; lastName?: string | undefined; username?: string | undefined },
): boolean {
  return (
    (current.firstName ?? undefined) === (next.firstName ?? undefined) &&
    (current.lastName ?? undefined) === (next.lastName ?? undefined) &&
    (current.username ?? undefined) === (next.username ?? undefined)
  );
}

/**
 * In-memory profile store keyed by telegramUserId. Persistence follows the
 * existing file-snapshot pattern (atomic tmp-file + rename, same-device
 * tmp so rename() never hits EXDEV), restored once at boot and saved
 * best-effort after every mutation.
 */
export class OperatorProfileStore {
  private readonly profiles = new Map<number, OperatorProfile>();
  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * Creates the profile on first touch, refreshes it when Telegram data
   * changed (e.g. the operator renamed their first_name). Returns
   * undefined for a `from` without a numeric id — callers then fall back
   * to the `Usuario <id>` chain only when an id is known.
   */
  upsert(from: TelegramFrom): OperatorProfile | undefined {
    const userId = from.id;
    if (typeof userId !== 'number' || !Number.isInteger(userId)) {
      return undefined;
    }
    const firstName = from.first_name?.trim() !== '' ? from.first_name?.trim() : undefined;
    const lastName = from.last_name?.trim() !== '' ? from.last_name?.trim() : undefined;
    const username = from.username?.trim() !== '' ? from.username?.trim() : undefined;
    const next = {
      ...(firstName !== undefined ? { firstName } : {}),
      ...(lastName !== undefined ? { lastName } : {}),
      ...(username !== undefined ? { username } : {}),
    };
    const current = this.profiles.get(userId);
    if (current !== undefined && sameParts(current, next)) {
      return current;
    }
    const profile: OperatorProfile = {
      telegramUserId: userId,
      ...next,
      displayName: buildDisplayName(firstName, lastName, username, userId),
      updatedAt: now(),
    };
    this.profiles.set(userId, profile);
    return profile;
  }

  get(userId: number): OperatorProfile | undefined {
    return this.profiles.get(userId);
  }

  /**
   * Central resolution: profile displayName when known, otherwise the
   * display chain built from live `from` fields (never empty).
   */
  resolveDisplayName(userId: number, from?: TelegramFrom): string {
    const known = this.profiles.get(userId);
    if (known !== undefined && (from === undefined || sameParts(known, {
      ...(from.first_name?.trim() !== '' ? { firstName: from.first_name?.trim() } : {}),
      ...(from.last_name?.trim() !== '' ? { lastName: from.last_name?.trim() } : {}),
      ...(from.username?.trim() !== '' ? { username: from.username?.trim() } : {}),
    }))) {
      return known.displayName;
    }
    if (from !== undefined) {
      const upserted = this.upsert({ ...from, id: userId });
      if (upserted !== undefined) {
        return upserted.displayName;
      }
    }
    if (known !== undefined) {
      return known.displayName;
    }
    return `Usuario ${userId}`;
  }

  /** Full in-memory snapshot (pure — for persistence and tests). */
  snapshot(): OperatorProfile[] {
    return [...this.profiles.values()];
  }

  /** Restores a snapshot, replacing all in-memory state. */
  restore(profiles: OperatorProfile[]): void {
    this.profiles.clear();
    for (const profile of profiles) {
      if (typeof profile?.telegramUserId !== 'number') {
        continue;
      }
      this.profiles.set(profile.telegramUserId, { ...profile });
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
      const tmpPath = join(dir, `.vokath-profiles-${process.pid}-${Date.now()}.tmp`);
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
    const valid = (parsed as OperatorProfile[]).filter(
      (profile) =>
        typeof profile?.telegramUserId === 'number' &&
        typeof profile?.displayName === 'string' &&
        profile.displayName !== '',
    );
    this.restore(valid);
  }
}

/**
 * Telegram Topics / Forum mode (additive, migration-safe).
 *
 * Mode A (default): no operator→topic mapping configured — the current
 * group-first behavior is unchanged.
 *
 * Mode B: `TELEGRAM_OPERATOR_TOPICS=userId:threadId,...` maps each
 * operator to their forum topic inside the shared group. Messages and
 * callbacks are validated against BOTH the owner (`from.id`) and the
 * thread (`message_thread_id`) — the thread NEVER replaces the owner.
 *
 * No topic id is ever hardcoded here (not even General): a message that
 * arrives outside every assigned topic is treated as "outside" and gets
 * the guide reply instead of starting any operation.
 */

/** operatorTelegramUserId → messageThreadId. Empty = Mode A. */
export type OperatorTopics = Map<number, number>;

/**
 * Fail-fast parser for `TELEGRAM_OPERATOR_TOPICS`.
 * Format: `userId:threadId,userId:threadId,...` — both sides must be
 * positive integers. Empty/missing yields an empty map (Mode A).
 * Throws on the first malformed entry so the process never boots with
 * a partial mapping.
 */
export function parseOperatorTopics(raw: string | undefined): OperatorTopics {
  const topics: OperatorTopics = new Map();
  if (raw === undefined || raw.trim() === '') {
    return topics;
  }
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    const match = /^(\d+)\s*:\s*(\d+)$/.exec(trimmed);
    if (match?.[1] === undefined || match?.[2] === undefined) {
      throw new Error(
        `Invalid TELEGRAM_OPERATOR_TOPICS entry: ${JSON.stringify(trimmed)} (expected userId:threadId)`,
      );
    }
    const userId = Number(match[1]);
    const threadId = Number(match[2]);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error(`Invalid Telegram user id in TELEGRAM_OPERATOR_TOPICS: ${match[1]}`);
    }
    if (!Number.isInteger(threadId) || threadId <= 0) {
      throw new Error(`Invalid Telegram thread id in TELEGRAM_OPERATOR_TOPICS: ${match[2]}`);
    }
    if (topics.has(userId)) {
      throw new Error(
        `Duplicate Telegram user id in TELEGRAM_OPERATOR_TOPICS: ${String(userId)}`,
      );
    }
    topics.set(userId, threadId);
  }
  return topics;
}

/** Reverse lookup: which operator owns this thread, if any. */
export function findTopicOwner(topics: OperatorTopics, threadId: number): number | undefined {
  for (const [userId, assigned] of topics) {
    if (assigned === threadId) {
      return userId;
    }
  }
  return undefined;
}

/**
 * Fail-fast parser for `TELEGRAM_ACTIVITY_TOPIC_ID`.
 * Empty/missing yields undefined (feature disabled). Otherwise must be
 * a positive integer thread id.
 */
export function parseActivityTopicId(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const threadId = Number(raw.trim());
  if (!Number.isInteger(threadId) || threadId <= 0) {
    throw new Error(`Invalid TELEGRAM_ACTIVITY_TOPIC_ID: ${JSON.stringify(raw)}`);
  }
  return threadId;
}

export interface DisplayNameInput {
  /** Operator alias / remembered name when one exists (preferred). */
  alias?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  userId: number;
}

/**
 * Display-name resolution chain — NEVER returns an empty string:
 * 1) operator alias/config when one exists,
 * 2) Telegram first_name + last_name,
 * 3) username,
 * 4) `Usuario <id>` fallback.
 */
export function resolveDisplayName(input: DisplayNameInput): string {
  const alias = input.alias?.trim();
  if (alias !== undefined && alias !== '') {
    return alias;
  }
  const full = `${input.firstName ?? ''} ${input.lastName ?? ''}`.trim().replace(/\s+/g, ' ');
  if (full !== '') {
    return full;
  }
  const username = input.username?.trim();
  if (username !== undefined && username !== '') {
    return username;
  }
  return `Usuario ${input.userId}`;
}

/** Cross-thread write rejection: names the topic's owner. */
export function topicMismatchText(ownerName: string): string {
  return `⚠️ Este espacio pertenece a ${ownerName}. Usa tu propio topic.`;
}

/** Guide reply for Mode B messages outside any assigned topic. */
export function topicGuideText(operatorName: string): string {
  return `⚠️ Usa tu topic para operar, ${operatorName}.`;
}

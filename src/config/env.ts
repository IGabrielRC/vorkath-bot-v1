import { z } from 'zod';

const csvOfTelegramIds = z
  .string()
  .min(1, 'AUTHORIZED_TELEGRAM_USER_IDS must not be empty')
  .regex(
    /^[0-9]+(\s*,\s*[0-9]+)*\s*$/,
    'AUTHORIZED_TELEGRAM_USER_IDS must be a comma-separated list of numeric Telegram user ids',
  );

/**
 * Group/supergroup chat ids are NEGATIVE (e.g. -1001234567890), so the
 * chat allowlist permits an optional leading minus per entry. Zero is
 * never a valid Telegram id and is rejected in `parseAuthorizedChatIds`.
 *
 * OPTIONAL: an empty/missing value means "no chat restriction" — only
 * AUTHORIZED_TELEGRAM_USER_IDS is enforced. When one or more ids are
 * configured, the chat restriction applies on top of user authorization.
 */
const csvOfTelegramChatIds = z
  .string()
  .default('')
  .refine(
    (raw) =>
      raw.trim() === '' ||
      /^-?[0-9]+(\s*,\s*-?[0-9]+)*\s*$/.test(raw),
    'AUTHORIZED_TELEGRAM_CHAT_IDS must be empty or a comma-separated list of numeric Telegram chat ids (group ids are negative)',
  );

/**
 * Operator→topic mapping for forum-mode groups. OPTIONAL — empty/missing
 * means Mode A (current group-first behavior, unchanged). When set, each
 * entry must be `userId:threadId` (both positive integers); anything else
 * fails fast at boot. No topic id is assumed — General included: anything
 * outside the assigned topics is guided, never executed.
 */
const operatorTopicsSchema = z
  .string()
  .default('')
  .refine(
    (raw) =>
      raw.trim() === '' ||
      raw
        .split(',')
        .every((entry) => /^\d+\s*:\s*\d+$/.test(entry.trim()) && !/:\s*0\b/.test(entry)),
    'TELEGRAM_OPERATOR_TOPICS must be empty or a comma-separated list of userId:threadId pairs (positive integers)',
  );

/** Activity-topic id for the single allowed summary event. OPTIONAL. */
const activityTopicIdSchema = z
  .string()
  .default('')
  .refine(
    (raw) => raw.trim() === '' || (/^\d+$/.test(raw.trim()) && Number(raw.trim()) > 0),
    'TELEGRAM_ACTIVITY_TOPIC_ID must be empty or a positive integer thread id',
  );

/**
 * Alerts-topic id (⭐ Alertas) for critical-alert delivery. OPTIONAL —
 * absent/undefined keeps every alert path disabled and never breaks
 * startup or /health. When present it must be a positive integer.
 * Kept `.optional()` (no default) so existing env objects keep compiling.
 */
const alertsTopicIdSchema = z
  .string()
  .optional()
  .refine(
    (raw) => raw === undefined || raw.trim() === '' || (/^\d+$/.test(raw.trim()) && Number(raw.trim()) > 0),
    'TELEGRAM_ALERTS_TOPIC_ID must be empty or a positive integer thread id',
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .min(16, 'TELEGRAM_WEBHOOK_SECRET must be at least 16 characters'),
  AUTHORIZED_TELEGRAM_USER_IDS: csvOfTelegramIds,
  AUTHORIZED_TELEGRAM_CHAT_IDS: csvOfTelegramChatIds,
  TELEGRAM_OPERATOR_TOPICS: operatorTopicsSchema,
  TELEGRAM_ACTIVITY_TOPIC_ID: activityTopicIdSchema,
  TELEGRAM_ALERTS_TOPIC_ID: alertsTopicIdSchema,
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  GEMINI_MODEL: z.string().min(1, 'GEMINI_MODEL is required'),
  PUBLIC_BASE_URL: z.string().url('PUBLIC_BASE_URL must be a valid URL'),
  REGISTER_TELEGRAM_WEBHOOK: z.enum(['true', 'false']).default('false'),
  MOCK_STATE_PATH: z.string().min(1).default('/data/mock-state.json'),
  DRAFTS_STATE_PATH: z.string().min(1).default('/data/drafts-state.json'),
  INTERACTIONS_STATE_PATH: z.string().min(1).default('/data/interactions-state.json'),
  /**
   * OperatorProfile snapshot. Defaults to /data so EasyPanel persists
   * profiles across redeploys with no new variable.
   */
  OPERATOR_PROFILES_STATE_PATH: z.string().min(1).default('/data/operator-profiles-state.json'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Fail-fast environment loader. Throws on first invalid/missing variable
 * so the process never boots with a partial configuration.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${details}`);
  }
  return parsed.data;
}

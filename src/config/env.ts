import { z } from 'zod';

const csvOfTelegramIds = z
  .string()
  .min(1, 'AUTHORIZED_TELEGRAM_USER_IDS must not be empty')
  .regex(
    /^[0-9]+(\s*,\s*[0-9]+)*\s*$/,
    'AUTHORIZED_TELEGRAM_USER_IDS must be a comma-separated list of numeric Telegram user ids',
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .min(16, 'TELEGRAM_WEBHOOK_SECRET must be at least 16 characters'),
  AUTHORIZED_TELEGRAM_USER_IDS: csvOfTelegramIds,
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  GEMINI_MODEL: z.string().min(1, 'GEMINI_MODEL is required'),
  PUBLIC_BASE_URL: z.string().url('PUBLIC_BASE_URL must be a valid URL'),
  REGISTER_TELEGRAM_WEBHOOK: z.enum(['true', 'false']).default('false'),
  MOCK_STATE_PATH: z.string().min(1).default('/data/mock-state.json'),
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

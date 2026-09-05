/**
 * Manual webhook registration entrypoint.
 *
 * Usage: `npx tsx scripts/setWebhook.ts`
 *
 * Reads TELEGRAM_BOT_TOKEN / PUBLIC_BASE_URL / TELEGRAM_WEBHOOK_SECRET
 * from the environment (fail-fast via `loadEnv`) and registers
 * `POST {PUBLIC_BASE_URL}/telegram/webhook`. The same call runs at boot
 * when REGISTER_TELEGRAM_WEBHOOK=true (see `src/app.ts`).
 *
 * EasyPanel deploy notes (Fase 1 live shell):
 * - Envs: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (16+ chars,
 *   A-Za-z0-9_- only per Telegram `secret_token` rules),
 *   AUTHORIZED_TELEGRAM_USER_IDS (Gabriel,Edward CSV), GEMINI_API_KEY,
 *   GEMINI_MODEL, PUBLIC_BASE_URL (public HTTPS URL), MOCK_STATE_PATH
 *   (/data/mock-state.json), REGISTER_TELEGRAM_WEBHOOK=true, PORT=3000.
 * - Build: `npm run build`. Start: `npm start`. Health: `GET /health`.
 *   Webhook: `POST /telegram/webhook`. Volume: `/data` (mock snapshot).
 */

import { loadEnv } from '../src/config/env';
import { registerWebhook } from '../src/telegram/setWebhook';
import { logger } from '../src/utils/logger';

async function main(): Promise<void> {
  const env = loadEnv();
  const ok = await registerWebhook({
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
  });
  if (!ok) {
    logger.error('Telegram setWebhook returned ok=false');
    process.exit(1);
  }
  logger.info('Telegram webhook registered');
}

main().catch((error) => {
  logger.error(error, 'Failed to register Telegram webhook');
  process.exit(1);
});

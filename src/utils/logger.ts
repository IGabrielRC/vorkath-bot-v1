import pino, { type Logger } from 'pino';

/**
 * Redaction paths covering every secret-bearing field in this service:
 * Telegram token/secret, Gemini key, Spanish PII columns
 * (CORREO/CONTRASEÑA) that flow through the MOCK plane, plus credential
 * material (passwords, PINs, WhatsApp URLs/texts). The pino list is a
 * defense-in-depth backstop — callers must still never log secrets;
 * see src/audit/audit.ts.
 * See: https://github.com/pinojs/pino/blob/main/docs/redaction.md
 */
const REDACT_PATHS = [
  'token',
  'secret',
  'apiKey',
  'api_key',
  'apikey',
  'authorization',
  'password',
  'pin',
  'PIN',
  'accountPassword',
  'whatsappUrl',
  'whatsappText',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'GEMINI_API_KEY',
  'telegramBotToken',
  'telegramWebhookSecret',
  'geminiApiKey',
  'correo',
  'contraseña',
  'CORREO',
  'CONTRASEÑA',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.password',
  '*.pin',
  '*.PIN',
  '*.accountPassword',
  '*.whatsappUrl',
  '*.whatsappText',
  '*.correo',
  '*.contraseña',
  '*.TELEGRAM_BOT_TOKEN',
  '*.TELEGRAM_WEBHOOK_SECRET',
  '*.GEMINI_API_KEY',
  'req.headers.authorization',
  'req.headers["x-telegram-bot-api-secret-token"]',
];

export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: '[Redacted]',
    },
  });
}

export const logger: Logger = createLogger();

/**
 * Webhook registration (`setWebhook`).
 *
 * Registers `POST {PUBLIC_BASE_URL}/telegram/webhook` with
 * `secret_token` (Telegram echoes it back as the
 * `X-Telegram-Bot-Api-Secret-Token` header on every update) and
 * `allowed_updates: ["message", "callback_query"]` — the only two update
 * types Fase 1 handles.
 * Source: https://core.telegram.org/bots/api#setwebhook
 */

export interface WebhookRegistration {
  telegramBotToken: string;
  publicBaseUrl: string;
  telegramWebhookSecret: string;
}

type FetchFn = typeof globalThis.fetch;

interface SetWebhookResult {
  ok?: boolean;
  description?: string;
}

/**
 * Registers the Telegram webhook. Returns true on `{"ok": true}`.
 * Throws on transport failure so boot fails loudly instead of
 * silently running without updates.
 */
export async function registerWebhook(
  registration: WebhookRegistration,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<boolean> {
  const baseUrl = registration.publicBaseUrl.replace(/\/+$/, '');
  const response = await fetchFn(
    `https://api.telegram.org/bot${registration.telegramBotToken}/setWebhook`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${baseUrl}/telegram/webhook`,
        secret_token: registration.telegramWebhookSecret,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      }),
    },
  );
  const data = (await (response as Response).json()) as SetWebhookResult;
  return data.ok === true;
}

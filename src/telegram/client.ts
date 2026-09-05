import type { InlineKeyboardMarkup } from './keyboards';

export interface SendMessageOpts {
  chatId: number;
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
}

export interface EditMessageOpts {
  chatId: number;
  messageId: number;
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
}

/**
 * Minimal Telegram Bot API client (send/edit/answer). HTTP only — no
 * business logic lives here; the router decides what to send.
 * See: https://core.telegram.org/bots/api#sendmessage
 */
export interface TelegramClient {
  sendMessage(opts: SendMessageOpts): Promise<unknown>;
  editMessageText(opts: EditMessageOpts): Promise<unknown>;
  answerCallbackQuery(callbackQueryId: string): Promise<unknown>;
}

type FetchFn = typeof globalThis.fetch;

export class HttpTelegramClient implements TelegramClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(token: string, fetchFn?: FetchFn) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async sendMessage(opts: SendMessageOpts): Promise<unknown> {
    return this.call('sendMessage', {
      chat_id: opts.chatId,
      text: opts.text,
      ...(opts.replyMarkup !== undefined ? { reply_markup: opts.replyMarkup } : {}),
    });
  }

  async editMessageText(opts: EditMessageOpts): Promise<unknown> {
    return this.call('editMessageText', {
      chat_id: opts.chatId,
      message_id: opts.messageId,
      text: opts.text,
      ...(opts.replyMarkup !== undefined ? { reply_markup: opts.replyMarkup } : {}),
    });
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<unknown> {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId });
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchFn(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return (response as Response).json() as Promise<unknown>;
  }
}

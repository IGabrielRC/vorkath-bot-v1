import type { InlineKeyboardMarkup } from './keyboards';

export interface SendMessageOpts {
  chatId: number;
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
  /**
   * Forum topic to post into (`message_thread_id` on the wire).
   * Replies inside a topic MUST carry the sender's thread — otherwise
   * Telegram drops them in General.
   */
  messageThreadId?: number;
}

export interface EditMessageOpts {
  chatId: number;
  messageId: number;
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
}

export interface AnswerCallbackOpts {
  /** Shown as a toast on ownership rejections (e.g. cross-actor taps). */
  text?: string;
}

/**
 * Centralized reply context: every fresh message the bot sends derives
 * its destination from ONE context object — never from a bare chatId.
 * `messageThreadId` is the origin topic (`message_thread_id` on the
 * wire); when present, `sendMessage` MUST carry it or Telegram drops the
 * reply in General. Undefined = General / non-forum chat (correct).
 */
export interface TelegramContext {
  chatId: number;
  messageThreadId?: number;
  actorTelegramUserId?: number;
}

/** Builds a thread-safe send payload from a centralized context. */
export function sendPayload(
  ctx: TelegramContext,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): SendMessageOpts {
  return {
    chatId: ctx.chatId,
    text,
    ...(replyMarkup !== undefined ? { replyMarkup } : {}),
    ...(ctx.messageThreadId !== undefined ? { messageThreadId: ctx.messageThreadId } : {}),
  };
}

/**
 * Minimal Telegram chat-member identity (subset of the Bot API User
 * object returned inside `getChatMember`). Display fields only — never
 * a security key.
 */
export interface ChatMember {
  first_name?: string;
  last_name?: string;
  username?: string;
}

/**
 * Minimal Telegram Bot API client (send/edit/answer). HTTP only — no
 * business logic lives here; the router decides what to send.
 * See: https://core.telegram.org/bots/api#sendmessage
 * See: https://core.telegram.org/bots/api#answercallbackquery
 *
 * `getChatMember` is OPTIONAL on purpose: it exists only as a
 * last-resort owner-name fallback on a profile-store miss (never on the
 * per-message hot path). Offline test stubs omit it and nothing breaks.
 * See: https://core.telegram.org/bots/api#getchatmember
 */
export interface TelegramClient {
  sendMessage(opts: SendMessageOpts): Promise<unknown>;
  editMessageText(opts: EditMessageOpts): Promise<unknown>;
  answerCallbackQuery(callbackQueryId: string, opts?: AnswerCallbackOpts): Promise<unknown>;
  getChatMember?(chatId: number, userId: number): Promise<ChatMember | undefined>;
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
      ...(opts.messageThreadId !== undefined ? { message_thread_id: opts.messageThreadId } : {}),
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

  async answerCallbackQuery(callbackQueryId: string, opts?: AnswerCallbackOpts): Promise<unknown> {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(opts?.text !== undefined ? { text: opts.text } : {}),
    });
  }

  /**
   * Last-resort owner identity lookup. Only called on a profile-store
   * miss by the webhook ownership guard — never per message.
   */
  async getChatMember(chatId: number, userId: number): Promise<ChatMember | undefined> {
    const result = (await this.call('getChatMember', {
      chat_id: chatId,
      user_id: userId,
    })) as { ok?: boolean; result?: { user?: Record<string, unknown> } };
    const user = result?.result?.user;
    if (user === undefined || user === null || typeof user !== 'object') {
      return undefined;
    }
    const member: ChatMember = {
      ...(typeof user['first_name'] === 'string' ? { first_name: user['first_name'] } : {}),
      ...(typeof user['last_name'] === 'string' ? { last_name: user['last_name'] } : {}),
      ...(typeof user['username'] === 'string' ? { username: user['username'] } : {}),
    };
    return member;
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

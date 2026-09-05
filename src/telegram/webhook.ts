import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IntentInterpreter } from '../ai/intentInterpreter';
import { isAuthorized } from '../auth/allowlist';
import type { Env } from '../config/env';
import { DraftEngine } from '../drafts/engine';
import type { MockRepositories } from '../mock/repositories';
import { route } from '../router/hybrid';
import { SessionStore } from '../session/store';
import { logger } from '../utils/logger';
import {
  HOME_TEXT,
  SECTION_TEXTS,
  draftKeyboard,
  homeKeyboard,
  sectionKeyboard,
} from './keyboards';
import type { TelegramClient } from './client';

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** Neutral reply for non-allowlisted users — no tools, no Gemini, no MOCK. */
export const UNAUTHORIZED_TEXT = '⛔ No tienes acceso a Vokath.';
export const UNKNOWN_TEXT = '❓ No entendí — usa los botones o /start.';
export const NO_RESULTS_TEXT = '🔎 Sin resultados MOCK.';
export const NO_DRAFT_TEXT = 'No hay borrador abierto. Usa ⚡OPERAR para crear uno.';
export const DRAFT_UPDATED_PREFIX = '📝 Borrador actualizado:';
export const CORRECTION_PROMPT_TEXT = '✏️ Envía la corrección (ej. «hazlo 2 meses»).';

/**
 * Timing-safe comparison: rejects before any session/router/Gemini/mock
 * processing when the Telegram secret header is missing or wrong.
 */
export function isValidWebhookSecret(
  received: string | string[] | undefined,
  expected: string,
): boolean {
  if (typeof received !== 'string' || received.length === 0) {
    return false;
  }
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export interface WebhookDeps {
  env: Env;
  allowlist: Set<number>;
  sessions: SessionStore;
  drafts: DraftEngine;
  interpreter: IntentInterpreter;
  repos: MockRepositories;
  client: TelegramClient;
}

interface TelegramUser {
  id?: number;
}

interface TelegramChat {
  id?: number;
}

interface TelegramMessage {
  message_id?: number;
  from?: TelegramUser;
  chat?: TelegramChat;
  text?: string;
}

interface TelegramCallbackQuery {
  id?: string;
  from?: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/**
 * Full webhook pipeline: secret gate (401) → allowlist (neutral, zero
 * side-channels) → update_id idempotency → per-user session touch →
 * L1/L2/L3 cascade → Telegram reply. Secrets and MOCK credentials are
 * never logged: log lines carry user/update ids and layer/action only.
 */
export function createWebhookHandler(deps: WebhookDeps) {
  return async function handleTelegramWebhook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
    const secret = request.headers[SECRET_HEADER];
    if (!isValidWebhookSecret(secret, deps.env.TELEGRAM_WEBHOOK_SECRET)) {
      logger.warn('Rejected Telegram webhook with invalid secret');
      return reply.code(401).send({ ok: false });
    }

    const update = (request.body ?? {}) as TelegramUpdate;
    const updateId = typeof update.update_id === 'number' ? update.update_id : undefined;
    const callback = update.callback_query;
    const userId = callback?.from?.id ?? update.message?.from?.id;
    const chatId = callback?.message?.chat?.id ?? update.message?.chat?.id;
    if (userId === undefined || chatId === undefined) {
      return { ok: true };
    }

    if (!isAuthorized(deps.allowlist, userId)) {
      logger.info({ userId, updateId }, 'Rejected unauthorized Telegram user');
      await deps.client.sendMessage({ chatId, text: UNAUTHORIZED_TEXT });
      return { ok: true };
    }

    if (updateId !== undefined && deps.sessions.markUpdateSeen(updateId)) {
      logger.info({ userId, updateId }, 'Ignored duplicate Telegram update');
      return { ok: true };
    }
    deps.sessions.touchSession(userId, updateId);

    const text = update.message?.text?.trim() ?? '';
    const callbackData = callback?.data;
    const decision = await route(
      {
        userId,
        ...(text.length > 0 ? { text } : {}),
        ...(callbackData !== undefined ? { callbackData } : {}),
      },
      deps.interpreter,
    );
    logger.info(
      { userId, updateId, layer: decision.layer },
      'Routed Telegram update',
    );

    // Narrowed once here: closures below do not preserve outer narrowing.
    const targetChatId: number = chatId;
    const fromCallback = callback !== undefined;
    const callbackId = callback?.id;
    const callbackMessageId = callback?.message?.message_id;

    /** Reply in place (edit) for button taps, fresh message otherwise. */
    async function respond(responseText: string, section?: string): Promise<void> {
      if (fromCallback && callbackMessageId !== undefined) {
        const markup =
          section !== undefined ? sectionKeyboard(section) : homeKeyboard();
        await deps.client.editMessageText({
          chatId: targetChatId,
          messageId: callbackMessageId,
          text: responseText,
          replyMarkup: markup,
        });
      } else {
        const markup =
          section !== undefined ? sectionKeyboard(section) : homeKeyboard();
        await deps.client.sendMessage({ chatId: targetChatId, text: responseText, replyMarkup: markup });
      }
      if (callbackId !== undefined) {
        await deps.client.answerCallbackQuery(callbackId);
      }
    }

    async function respondDraft(responseText: string): Promise<void> {
      if (fromCallback && callbackMessageId !== undefined) {
        await deps.client.editMessageText({
          chatId: targetChatId,
          messageId: callbackMessageId,
          text: responseText,
          replyMarkup: draftKeyboard(),
        });
      } else {
        await deps.client.sendMessage({
          chatId: targetChatId,
          text: responseText,
          replyMarkup: draftKeyboard(),
        });
      }
      if (callbackId !== undefined) {
        await deps.client.answerCallbackQuery(callbackId);
      }
    }

    if (decision.layer === 'noop') {
      if (callbackId !== undefined) {
        await deps.client.answerCallbackQuery(callbackId);
      }
      return { ok: true };
    }

    if (decision.layer === 'L1') {
      const action = decision.action;
      if (action === 'home' || action === 'back') {
        await respond(HOME_TEXT);
        return { ok: true };
      }
      if (action === 'buscar') {
        await respond(SECTION_TEXTS['buscar'] ?? '🔎 BUSCAR (demo)', 'buscar');
        return { ok: true };
      }
      if (action === 'operar') {
        deps.drafts.create(userId);
        await respondDraft(
          '📝 Borrador MOCK abierto (paso 1 de 2). Envía la corrección o confirma.',
        );
        return { ok: true };
      }
      if (action === 'vencidos') {
        const expired = await deps.repos.getExpiredAccounts();
        const lines = expired
          .slice(0, 5)
          .map((row) => `• ${row.nombre} — ${row.perfil} (${row.pais}, ${row.estatus})`);
        await respond(
          expired.length === 0
            ? '⏰ Sin vencidos MOCK.'
            : `⏰ Vencidos MOCK (${expired.length}):\n${lines.join('\n')}`,
          'vencidos',
        );
        return { ok: true };
      }
      if (action === 'inventario') {
        const summary = await deps.repos.getInventorySummary();
        const lines = summary.map((row) => `• ${row.servicio}: ${row.total}`);
        await respond(
          lines.length === 0
            ? '📦 Inventario MOCK vacío.'
            : `📦 Inventario MOCK:\n${lines.join('\n')}`,
          'inventario',
        );
        return { ok: true };
      }
      if (action === 'confirm') {
        const result = deps.drafts.confirm(userId);
        await respondDraft(result.text);
        return { ok: true };
      }
      if (action === 'cancel') {
        const result = deps.drafts.cancel(userId);
        await respondDraft(result.text);
        return { ok: true };
      }
      if (action === 'correct') {
        await respondDraft(CORRECTION_PROMPT_TEXT);
        return { ok: true };
      }
      const sectionText = SECTION_TEXTS[action] ?? SECTION_TEXTS['mas'] ?? '⋯ MÁS (demo)';
      await respond(sectionText, action);
      return { ok: true };
    }

    if (decision.layer === 'L2') {
      const parse = decision.parse;
      if (parse.kind === 'command') {
        if (parse.command === 'confirmar') {
          await respondDraft(deps.drafts.confirm(userId).text);
          return { ok: true };
        }
        if (parse.command === 'cancelar') {
          await respondDraft(deps.drafts.cancel(userId).text);
          return { ok: true };
        }
        if (parse.command === 'volver') {
          await respond(HOME_TEXT);
          return { ok: true };
        }
        const placeholders: Record<string, string> = {
          codigo: '🔧 Código de instalación (demo MOCK).',
          tasa: '💱 Tasa (demo MOCK).',
          precio: '🏷️ Precios (demo MOCK).',
        };
        await respond(placeholders[parse.command] ?? '⋯ MÁS (demo)', 'mas');
        return { ok: true };
      }
      if (parse.kind === 'phone' || parse.kind === 'email') {
        const rows = await deps.repos.searchAccounts(parse.value);
        if (rows.length === 0) {
          await respond(NO_RESULTS_TEXT, 'buscar');
          return { ok: true };
        }
        const lines = rows
          .slice(0, 5)
          .map((row) => `• ${row.nombre} — ${row.perfil} (${row.pais}, ${row.estatus})`);
        await respond(`🔎 ${rows.length} resultado(s) MOCK:\n${lines.join('\n')}`, 'buscar');
        return { ok: true };
      }
      if (parse.kind === 'months') {
        const updated = deps.drafts.update(userId, { months: parse.months });
        if (updated === undefined) {
          await respond(NO_DRAFT_TEXT);
          return { ok: true };
        }
        await respondDraft(
          `${DRAFT_UPDATED_PREFIX} ${updated.months} mes(es) (paso 2 de 2). Confirma o cancela.`,
        );
        return { ok: true };
      }
      await respond(UNKNOWN_TEXT);
      return { ok: true };
    }

    // L3 — Gemini intent only; execution stays deterministic.
    const intent = decision.intent;
    if (intent.name === 'OPEN_SEARCH') {
      await respond(SECTION_TEXTS['buscar'] ?? '🔎 BUSCAR (demo)', 'buscar');
      return { ok: true };
    }
    if (intent.name === 'CREATE_TEST_DRAFT') {
      deps.drafts.create(userId);
      await respondDraft('📝 Borrador MOCK abierto (paso 1 de 2). Envía la corrección o confirma.');
      return { ok: true };
    }
    if (intent.name === 'CORRECTION') {
      const months = typeof intent.params['months'] === 'number' ? intent.params['months'] : 1;
      const updated = deps.drafts.update(userId, { months });
      if (updated === undefined) {
        await respond(NO_DRAFT_TEXT);
        return { ok: true };
      }
      await respondDraft(
        `${DRAFT_UPDATED_PREFIX} ${updated.months} mes(es) (paso 2 de 2). Confirma o cancela.`,
      );
      return { ok: true };
    }
    await respond(UNKNOWN_TEXT);
    return { ok: true };
  };
}

import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IntentInterpreter } from '../ai/intentInterpreter';
import { isAuthorized, isAuthorizedChat } from '../auth/allowlist';
import { type Auditor, createAuditor } from '../audit/audit';
import type { Env } from '../config/env';
import { DraftEngine, type DraftOwner, type DraftResult } from '../drafts/engine';
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
  chatAllowlist: Set<number>;
  sessions: SessionStore;
  drafts: DraftEngine;
  interpreter: IntentInterpreter;
  repos: MockRepositories;
  client: TelegramClient;
  auditor?: Auditor;
  /** File path for best-effort draft persistence; undefined disables it. */
  draftsStatePath?: string;
}

interface TelegramUser {
  id?: number;
  first_name?: string;
  username?: string;
}

interface TelegramChat {
  id?: number;
  type?: string;
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
 * Shared-group webhook pipeline.
 *
 * GROUP PRIVACY MODE MUST BE OFF (BotFather → Bot Settings → Group Privacy
 * → Turn off) so the bot receives plain group messages — not only
 * commands, replies, and mentions. With privacy ON, NORMAL group messages
 * never reach this handler and the shared operation flow silently breaks.
 *
 * Identity rule: `chat.id` is the shared visible context (one private
 * group for both owners); `from.id` is the operator identity. Every
 * action requires BOTH an authorized chat AND an authorized operator.
 * Drafts resolve strictly through (chatId, actorId) — never through the
 * chat alone. Secrets and MOCK credentials are never logged: log lines
 * carry user/update ids and layer/action only.
 *
 * Full pipeline: secret gate (401) → user+chat allowlist (neutral, zero
 * side-channels) → update_id idempotency → per-actor session touch →
 * L1/L2/L3 cascade → Telegram reply. Rejected updates touch nothing:
 * no session, no draft, no Gemini, no MOCK.
 */
export function createWebhookHandler(deps: WebhookDeps) {
  const auditor = deps.auditor ?? createAuditor();
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
    const message = update.message;
    // Operator identity ALWAYS comes from `from.id` — never from chat.id.
    const actorId = callback?.from?.id ?? message?.from?.id;
    const chatId = callback?.message?.chat?.id ?? message?.chat?.id;
    if (actorId === undefined || chatId === undefined) {
      return { ok: true };
    }
    const actorName =
      callback?.from?.first_name ??
      message?.from?.first_name ??
      callback?.from?.username ??
      message?.from?.username;

    if (!isAuthorized(deps.allowlist, actorId)) {
      logger.info({ userId: actorId, chatId, updateId }, 'Rejected unauthorized Telegram user');
      auditor.record({
        chatId,
        actorTelegramUserId: actorId,
        ...(actorName !== undefined ? { actorName } : {}),
        actionType: 'auth.rejected_user',
        ...(updateId !== undefined ? { metadata: { updateId } } : {}),
      });
      await deps.client.sendMessage({ chatId, text: UNAUTHORIZED_TEXT });
      return { ok: true };
    }

    if (!isAuthorizedChat(deps.chatAllowlist, chatId)) {
      logger.info({ userId: actorId, chatId, updateId }, 'Rejected unauthorized Telegram chat');
      auditor.record({
        chatId,
        actorTelegramUserId: actorId,
        ...(actorName !== undefined ? { actorName } : {}),
        actionType: 'auth.rejected_chat',
        ...(updateId !== undefined ? { metadata: { updateId } } : {}),
      });
      await deps.client.sendMessage({ chatId, text: UNAUTHORIZED_TEXT });
      return { ok: true };
    }

    if (updateId !== undefined && deps.sessions.markUpdateSeen(updateId)) {
      logger.info({ userId: actorId, updateId }, 'Ignored duplicate Telegram update');
      return { ok: true };
    }
    deps.sessions.touchSession(actorId, updateId, chatId);

    const text = message?.text?.trim() ?? '';
    const callbackData = callback?.data;
    const decision = await route(
      {
        userId: actorId,
        chatId,
        ...(text.length > 0 ? { text } : {}),
        ...(callbackData !== undefined ? { callbackData } : {}),
      },
      deps.interpreter,
    );
    logger.info(
      { userId: actorId, chatId, updateId, layer: decision.layer },
      'Routed Telegram update',
    );

    // Narrowed once here: closures below do not preserve outer narrowing.
    const targetChatId: number = chatId;
    const targetActorId: number = actorId;
    const targetActorName: string | undefined = actorName;
    const owner: DraftOwner = {
      chatId: targetChatId,
      userId: targetActorId,
      ...(targetActorName !== undefined ? { name: targetActorName } : {}),
    };
    const draftEntity = `draft:${targetChatId}:${targetActorId}`;
    const fromCallback = callback !== undefined;
    const callbackId = callback?.id;
    const callbackMessageId = callback?.message?.message_id;

    /** Best-effort draft persist — a failed save never breaks the reply. */
    function persistDrafts(): void {
      if (deps.draftsStatePath === undefined) {
        return;
      }
      deps.drafts.saveToFile(deps.draftsStatePath).catch((error) => {
        logger.warn({ error }, 'Draft persist failed');
      });
    }

    function auditDraft(
      actionType: string,
      metadata?: Record<string, unknown>,
      entity: string = draftEntity,
    ): void {
      auditor.record({
        chatId: targetChatId,
        actorTelegramUserId: targetActorId,
        ...(targetActorName !== undefined ? { actorName: targetActorName } : {}),
        actionType,
        entity,
        ...(metadata !== undefined ? { metadata } : {}),
      });
    }

    /**
     * Cross-actor ownership guard for confirm/cancel. The action applies
     * ONLY to the actor's own open draft. When the actor has none but a
     * peer owns an open draft in this chat, reply with the ownership
     * warning and modify NOTHING (the peer's draft stays open).
     */
    function confirmOrCancel(kind: 'confirm' | 'cancel'): DraftResult {
      const own = deps.drafts.get(owner);
      if (own !== undefined && own.status === 'open') {
        const result = kind === 'confirm' ? deps.drafts.confirm(owner) : deps.drafts.cancel(owner);
        persistDrafts();
        auditDraft(kind === 'confirm' ? 'draft.confirmed' : 'draft.cancelled', {
          months: own.months,
        });
        return result;
      }
      const peer = deps.drafts.findOtherOpenDraft(targetChatId, targetActorId);
      if (peer !== undefined) {
        auditDraft(
          'draft.blocked_cross_actor',
          {
            requestedAction: kind,
            ownerUserId: peer.userId,
            ...(peer.ownerName !== undefined ? { ownerName: peer.ownerName } : {}),
          },
          `draft:${peer.chatId}:${peer.userId}`,
        );
        return {
          ok: false,
          text: `⚠️ Esta operación pertenece a ${peer.ownerName ?? 'otro operador'}.`,
        };
      }
      return kind === 'confirm' ? deps.drafts.confirm(owner) : deps.drafts.cancel(owner);
    }

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

    /**
     * Draft reply. Terminal states (confirmed/cancelled/no-draft/blocked)
     * land back on the HOME keyboard instead of re-showing draft buttons:
     * re-attaching Confirmar/Cancelar after a dead end is what trapped
     * users in the cancel loop (tap Cancelar → dead-end text → tap
     * Cancelar again, forever).
     */
    async function respondDraft(responseText: string, terminal = false): Promise<void> {
      if (fromCallback && callbackMessageId !== undefined) {
        await deps.client.editMessageText({
          chatId: targetChatId,
          messageId: callbackMessageId,
          text: responseText,
          replyMarkup: terminal ? homeKeyboard() : draftKeyboard(),
        });
      } else {
        await deps.client.sendMessage({
          chatId: targetChatId,
          text: responseText,
          replyMarkup: terminal ? homeKeyboard() : draftKeyboard(),
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
        // Navigation never touches drafts — both actors' state survives.
        await respond(HOME_TEXT);
        return { ok: true };
      }
      if (action === 'buscar') {
        await respond(SECTION_TEXTS['buscar'] ?? '🔎 BUSCAR (demo)', 'buscar');
        return { ok: true };
      }
      if (action === 'operar') {
        const resumed = deps.drafts.isOpen(owner);
        const draft = deps.drafts.create(owner, {
          ...(targetActorName !== undefined ? { ownerName: targetActorName } : {}),
        });
        persistDrafts();
        auditDraft('draft.created', { months: draft.months, resumed });
        await respondDraft(
          resumed
            ? `📝 Borrador retomado: ${draft.months} mes(es) (paso 2 de 2). Confirma o cancela.`
            : '📝 Borrador MOCK abierto (paso 1 de 2). Envía la corrección o confirma.',
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
        const result = confirmOrCancel('confirm');
        await respondDraft(result.text, true);
        return { ok: true };
      }
      if (action === 'cancel') {
        const result = confirmOrCancel('cancel');
        await respondDraft(result.text, true);
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
          const result = confirmOrCancel('confirm');
          await respondDraft(result.text, true);
          return { ok: true };
        }
        if (parse.command === 'cancelar') {
          const result = confirmOrCancel('cancel');
          await respondDraft(result.text, true);
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
      if (parse.kind === 'phone' || parse.kind === 'email' || parse.kind === 'service') {
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
        const updated = deps.drafts.update(owner, { months: parse.months });
        if (updated === undefined) {
          await respond(NO_DRAFT_TEXT);
          return { ok: true };
        }
        persistDrafts();
        auditDraft('draft.updated', { months: updated.months });
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
      const resumed = deps.drafts.isOpen(owner);
      const draft = deps.drafts.create(owner, {
        ...(targetActorName !== undefined ? { ownerName: targetActorName } : {}),
      });
      persistDrafts();
      auditDraft('draft.created', { months: draft.months, resumed });
      await respondDraft(
        resumed
          ? `📝 Borrador retomado: ${draft.months} mes(es) (paso 2 de 2). Confirma o cancela.`
          : '📝 Borrador MOCK abierto (paso 1 de 2). Envía la corrección o confirma.',
      );
      return { ok: true };
    }
    if (intent.name === 'CORRECTION') {
      const months = typeof intent.params['months'] === 'number' ? intent.params['months'] : 1;
      const updated = deps.drafts.update(owner, { months });
      if (updated === undefined) {
        await respond(NO_DRAFT_TEXT);
        return { ok: true };
      }
      persistDrafts();
      auditDraft('draft.updated', { months: updated.months });
      await respondDraft(
        `${DRAFT_UPDATED_PREFIX} ${updated.months} mes(es) (paso 2 de 2). Confirma o cancela.`,
      );
      return { ok: true };
    }
    await respond(UNKNOWN_TEXT);
    return { ok: true };
  };
}

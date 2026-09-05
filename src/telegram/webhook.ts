import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IntentInterpreter } from '../ai/intentInterpreter';
import { isAuthorized, isAuthorizedChat } from '../auth/allowlist';
import { type Auditor, createAuditor } from '../audit/audit';
import type { Env } from '../config/env';
import { DraftEngine, type DraftOwner, type DraftResult } from '../drafts/engine';
import {
  InteractionStore,
  type Interaction,
  type InteractionType,
} from '../interactions/interactions';
import type { MockRepositories, SafeAccount } from '../mock/repositories';
import { route } from '../router/hybrid';
import { SessionStore } from '../session/store';
import { logger } from '../utils/logger';
import {
  HOME_TEXT,
  SECTION_TEXTS,
  draftKeyboard,
  homeKeyboard,
  searchResultsKeyboard,
  sectionKeyboard,
  withOperator,
  type CallbackAction,
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
/** Idempotent repeat-cancel: the operation is already dead — no loop, no mutation. */
export const CANCELLED_TEXT = 'Esta operación ya fue cancelada.';

/** Ownership rejection for interaction-bound buttons (toast on the tap). */
export function crossActionText(ownerName: string | undefined): string {
  return `Esta acción pertenece a ${ownerName ?? 'otro operador'}.`;
}

/** Rejection when replying to another operator's interactive message. */
export function replyBelongsText(ownerName: string): string {
  return `⚠️ Este requerimiento pertenece a ${ownerName}.`;
}

/**
 * Extracts the owner display name from a bot message carrying the
 * `👤 Operador: <nombre>` label. Returns undefined for unlabeled
 * (pre-ownership or non-interactive) messages, which impose no reply guard.
 */
export function parseOperatorLabel(text: string | undefined): string | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }
  const match = /👤 Operador:\s*([^\n]+)/u.exec(text);
  const name = match?.[1]?.trim();
  return name !== undefined && name !== '' ? name : undefined;
}

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
  interactions: InteractionStore;
  interpreter: IntentInterpreter;
  repos: MockRepositories;
  client: TelegramClient;
  auditor?: Auditor;
  /** File path for best-effort draft persistence; undefined disables it. */
  draftsStatePath?: string;
  /** File path for best-effort interaction persistence; undefined disables it. */
  interactionsStatePath?: string;
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
  reply_to_message?: TelegramMessage;
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

/** Search page size: matches the five Ver-cliente buttons (view0–view4). */
const SEARCH_PAGE_SIZE = 5;

const VIEW_ACTIONS: CallbackAction[] = ['view0', 'view1', 'view2', 'view3', 'view4'];

function viewIndexFor(action: string): number | null {
  const index = VIEW_ACTIONS.indexOf(action as CallbackAction);
  return index >= 0 ? index : null;
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
 * Every requirement is an Interaction owned by (chatId,
 * ownerTelegramUserId): buttons carry the interactionId, text input
 * consults ONLY the sender's active interaction, and Gemini receives only
 * that actor's identity — never the group's mutable session, never a
 * peer's state. Drafts resolve strictly through (chatId, actorId) — never
 * through the chat alone. Secrets and MOCK credentials are never logged:
 * log lines carry user/update ids and layer/action only.
 *
 * Full pipeline: secret gate (401) → user+chat allowlist (neutral, zero
 * side-channels) → update_id idempotency → per-actor session touch →
 * reply-ownership guard → L1/L2/L3 cascade → Telegram reply. Rejected
 * updates touch nothing: no session, no draft, no interaction, no Gemini,
 * no MOCK.
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
    deps.interactions.rememberOperator(targetChatId, targetActorId, targetActorName);

    /**
     * Reply-ownership guard: when the sender replies to a labeled
     * interactive message owned by a peer, reject the continuation with
     * the ownership warning and alter NOTHING (no state, no draft, no
     * navigation, no Gemini). Unlabeled messages impose no guard.
     */
    if (message?.reply_to_message !== undefined && message.text !== undefined) {
      const labelName = parseOperatorLabel(message.reply_to_message.text);
      if (labelName !== undefined) {
        const labeledOwnerId = deps.interactions.resolveUserIdByName(
          targetChatId,
          labelName,
        );
        const isSelf =
          labeledOwnerId !== undefined
            ? labeledOwnerId === targetActorId
            : targetActorName !== undefined && targetActorName === labelName;
        if (!isSelf) {
          auditor.record({
            chatId: targetChatId,
            actorTelegramUserId: targetActorId,
            ...(targetActorName !== undefined ? { actorName: targetActorName } : {}),
            actionType: 'interaction.blocked_cross_reply',
            ...(labeledOwnerId !== undefined
              ? { metadata: { ownerUserId: labeledOwnerId, ownerName: labelName } }
              : { metadata: { ownerName: labelName } }),
          });
          await deps.client.sendMessage({
            chatId: targetChatId,
            text: replyBelongsText(labelName),
          });
          return { ok: true };
        }
      }
    }

    const text = message?.text?.trim() ?? '';
    const callbackData = callback?.data;
    const decision = await route(
      {
        userId: actorId,
        chatId,
        ...(targetActorName !== undefined ? { ownerName: targetActorName } : {}),
        ...(text.length > 0 ? { text } : {}),
        ...(callbackData !== undefined ? { callbackData } : {}),
      },
      deps.interpreter,
    );
    logger.info(
      { userId: actorId, chatId, updateId, layer: decision.layer },
      'Routed Telegram update',
    );

    /** Best-effort persists — a failed save never breaks the reply. */
    function persistAll(): void {
      if (deps.draftsStatePath !== undefined) {
        deps.drafts.saveToFile(deps.draftsStatePath).catch((error) => {
          logger.warn({ error }, 'Draft persist failed');
        });
      }
      if (deps.interactionsStatePath !== undefined) {
        deps.interactions.saveToFile(deps.interactionsStatePath).catch((error) => {
          logger.warn({ error }, 'Interaction persist failed');
        });
      }
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

    function auditInteraction(
      actionType: string,
      interaction: Interaction,
      metadata?: Record<string, unknown>,
    ): void {
      auditor.record({
        chatId: targetChatId,
        actorTelegramUserId: targetActorId,
        ...(targetActorName !== undefined ? { actorName: targetActorName } : {}),
        actionType,
        entity: `interaction:${interaction.id}`,
        metadata: {
          interactionType: interaction.type,
          ownerUserId: interaction.ownerTelegramUserId,
          ...(interaction.ownerName !== undefined ? { ownerName: interaction.ownerName } : {}),
          ...(metadata !== undefined ? metadata : {}),
        },
      });
    }

    /** Creates an interaction owned by this update's actor. */
    function createInteraction(
      type: InteractionType,
      state?: Record<string, unknown>,
    ): Interaction {
      const interaction = deps.interactions.create(
        targetChatId,
        targetActorId,
        type,
        {
          ...(targetActorName !== undefined ? { ownerName: targetActorName } : {}),
          ...(state !== undefined ? { state } : {}),
        },
      );
      auditInteraction('interaction.created', interaction);
      return interaction;
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
        persistAll();
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

    /**
     * Cancel with idempotent repeats: PENDING→CANCELLED once; later
     * repeats answer "Esta operación ya fue cancelada." with no loop, no
     * recreation, no extra mutation.
     */
    function cancelWithIdempotency(): DraftResult {
      const own = deps.drafts.get(owner);
      if (own !== undefined && own.status === 'cancelled') {
        return { ok: false, text: CANCELLED_TEXT };
      }
      return confirmOrCancel('cancel');
    }

    /** Cross-actor guard for Corregir: blocked when only a peer owns a draft. */
    function correctGuard(): DraftResult | null {
      const own = deps.drafts.get(owner);
      if (own !== undefined && own.status === 'open') {
        return null;
      }
      const peer = deps.drafts.findOtherOpenDraft(targetChatId, targetActorId);
      if (peer !== undefined) {
        auditDraft(
          'draft.blocked_cross_actor',
          {
            requestedAction: 'correct',
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
      return null;
    }

    /**
     * Resolves an interaction-bound callback: interaction → chat → owner →
     * state. Returns the interaction when this actor owns it and may
     * execute, otherwise rejects WITHOUT executing, editing, mutating, or
     * navigating (wrong-owner taps only get the toast).
     */
    function resolveOwnedInteraction(interactionId: string): Interaction | undefined {
      return deps.interactions.get(interactionId);
    }

    async function rejectTap(
      interaction: Interaction | undefined,
      requestedAction: string,
    ): Promise<true> {
      const ownerName = interaction?.ownerName;
      if (callbackId !== undefined) {
        await deps.client.answerCallbackQuery(callbackId, {
          text: crossActionText(ownerName),
        });
      }
      if (interaction !== undefined) {
        auditInteraction('interaction.blocked_cross_actor', interaction, {
          requestedAction,
        });
      } else {
        auditor.record({
          chatId: targetChatId,
          actorTelegramUserId: targetActorId,
          ...(targetActorName !== undefined ? { actorName: targetActorName } : {}),
          actionType: 'interaction.blocked_unknown',
          metadata: { requestedAction },
        });
      }
      return true;
    }

    /** Plain ack for stale callbacks: safe no-op, zero state change. */
    async function ackStale(requestedAction?: string): Promise<void> {
      if (callbackId !== undefined) {
        await deps.client.answerCallbackQuery(callbackId);
      }
      auditor.record({
        chatId: targetChatId,
        actorTelegramUserId: targetActorId,
        ...(targetActorName !== undefined ? { actorName: targetActorName } : {}),
        actionType: 'interaction.stale_callback',
        ...(requestedAction !== undefined ? { metadata: { requestedAction } } : {}),
      });
    }

    /** Labeled send-or-edit: every interactive message shows its operator. */
    async function sendLabeled(
      responseText: string,
      replyMarkup:
        | ReturnType<typeof homeKeyboard>
        | ReturnType<typeof sectionKeyboard>
        | ReturnType<typeof draftKeyboard>
        | ReturnType<typeof searchResultsKeyboard>,
    ): Promise<void> {
      const labeled = withOperator(responseText, targetActorName);
      if (fromCallback && callbackMessageId !== undefined) {
        await deps.client.editMessageText({
          chatId: targetChatId,
          messageId: callbackMessageId,
          text: labeled,
          replyMarkup,
        });
      } else {
        await deps.client.sendMessage({
          chatId: targetChatId,
          text: labeled,
          replyMarkup,
        });
      }
      if (callbackId !== undefined) {
        await deps.client.answerCallbackQuery(callbackId);
      }
    }

    /** Reply in place (edit) for button taps, fresh message otherwise. */
    async function respond(responseText: string, section?: string): Promise<void> {
      const interaction = createInteraction(
        section === undefined ? 'HOME' : sectionInteractionType(section),
      );
      const markup =
        section !== undefined
          ? sectionKeyboard(section, interaction.id)
          : homeKeyboard(interaction.id);
      persistAll();
      if (fromCallback && callbackMessageId !== undefined) {
        await deps.client.editMessageText({
          chatId: targetChatId,
          messageId: callbackMessageId,
          text: withOperator(responseText, targetActorName),
          replyMarkup: markup,
        });
      } else {
        await deps.client.sendMessage({
          chatId: targetChatId,
          text: withOperator(responseText, targetActorName),
          replyMarkup: markup,
        });
      }
      if (callbackId !== undefined) {
        await deps.client.answerCallbackQuery(callbackId);
      }
    }

    /**
     * Draft reply. Terminal states (confirmed/cancelled/no-draft/blocked)
     * land back on an owned HOME keyboard instead of re-showing draft
     * buttons: re-attaching Confirmar/Cancelar after a dead end is what
     * trapped users in the cancel loop (tap Cancelar → dead-end text →
     * tap Cancelar again, forever).
     */
    async function respondDraft(responseText: string, terminal = false): Promise<void> {
      if (terminal) {
        const home = createInteraction('HOME');
        persistAll();
        await sendLabeled(responseText, homeKeyboard(home.id));
        return;
      }
      const interaction = activeOperationInteraction() ?? createInteraction('OPERATION');
      persistAll();
      await sendLabeled(responseText, draftKeyboard(interaction.id));
    }

    /** Actor's latest PENDING OPERATION/DRAFT interaction, if any. */
    function activeOperationInteraction(): Interaction | undefined {
      const active = deps.interactions.getActive(targetChatId, targetActorId);
      if (
        active !== undefined &&
        (active.type === 'OPERATION' || active.type === 'DRAFT')
      ) {
        return active;
      }
      return undefined;
    }

    function sectionInteractionType(section: string | undefined): InteractionType {
      switch (section) {
        case 'buscar':
          return 'SEARCH';
        case 'vencidos':
          return 'EXPIRED';
        case 'inventario':
          return 'INVENTORY';
        case 'caja':
          return 'CASH';
        default:
          return 'MORE';
      }
    }

    function formatRows(rows: SafeAccount[]): string {
      return rows
        .map((row) => `• ${row.nombre} — ${row.perfil} (${row.pais}, ${row.estatus})`)
        .join('\n');
    }

    /** Renders one SEARCH page; state stays on the owned interaction. */
    async function renderSearchPage(interaction: Interaction, query: string): Promise<void> {
      const offset =
        typeof interaction.state['offset'] === 'number'
          ? (interaction.state['offset'] as number)
          : 0;
      const rows = await deps.repos.searchAccounts(query);
      const total = rows.length;
      if (total === 0) {
        deps.interactions.touch(interaction.id, { query, offset: 0, view: 'list' });
        persistAll();
        await sendLabeled(
          NO_RESULTS_TEXT,
          sectionKeyboard('buscar', interaction.id),
        );
        return;
      }
      const safeOffset = Math.min(Math.max(offset, 0), Math.max(total - 1, 0));
      const page = rows.slice(safeOffset, safeOffset + SEARCH_PAGE_SIZE);
      const lines = page.map(
        (row, index) =>
          `${safeOffset + index + 1}. ${row.nombre} — ${row.perfil} (${row.pais}, ${row.estatus})`,
      );
      deps.interactions.touch(interaction.id, {
        query,
        offset: safeOffset,
        view: 'list',
        total,
      });
      persistAll();
      await sendLabeled(
        `🔎 ${total} resultado(s) MOCK:\n${lines.join('\n')}`,
        searchResultsKeyboard(page.length, {
          interactionId: interaction.id,
          hasNext: safeOffset + SEARCH_PAGE_SIZE < total,
          hasPrev: safeOffset > 0,
        }),
      );
    }

    /** Renders one account detail; Volver returns to the owned result list. */
    async function renderAccountDetail(
      interaction: Interaction,
      query: string,
      globalIndex: number,
    ): Promise<void> {
      const rows = await deps.repos.searchAccounts(query);
      const row = rows[globalIndex];
      if (row === undefined) {
        await ackStale('view');
        return;
      }
      deps.interactions.touch(interaction.id, {
        query,
        view: 'detail',
        selectedIndex: globalIndex,
      });
      persistAll();
      await sendLabeled(
        `👤 Cliente MOCK (${globalIndex + 1} de ${rows.length}):\n• Nombre: ${row.nombre}\n• Perfil: ${row.perfil}\n• Servicio: ${row.servicio}\n• País: ${row.pais}\n• Estatus: ${row.estatus}`,
        sectionKeyboard('buscar', interaction.id),
      );
    }

    /** Owned-callback execution: ownership already verified by the caller. */
    async function executeOwned(
      action: string,
      interaction: Interaction,
    ): Promise<void> {
      if (action === 'home' || action === 'back') {
        if (interaction.type === 'SEARCH' && interaction.state['view'] === 'detail') {
          // Volver belongs to the interaction: back to the owned list,
          // never deleting drafts or persistent requirements.
          const query =
            typeof interaction.state['query'] === 'string'
              ? (interaction.state['query'] as string)
              : '';
          await renderSearchPage(interaction, query);
          return;
        }
        // Navigation never touches drafts — both actors' state survives.
        const home = createInteraction('HOME');
        persistAll();
        await sendLabeled(HOME_TEXT, homeKeyboard(home.id));
        return;
      }
      if (action === 'buscar') {
        const view = createInteraction('SEARCH', { view: 'prompt' });
        persistAll();
        await sendLabeled(
          SECTION_TEXTS['buscar'] ?? '🔎 BUSCAR (demo)',
          sectionKeyboard('buscar', view.id),
        );
        return;
      }
      if (action === 'operar') {
        const resumed = deps.drafts.isOpen(owner);
        const draft = deps.drafts.create(owner, {
          ...(targetActorName !== undefined ? { ownerName: targetActorName } : {}),
        });
        const operation = createInteraction('OPERATION');
        persistAll();
        auditDraft('draft.created', { months: draft.months, resumed });
        if (fromCallback && callbackMessageId !== undefined) {
          await deps.client.editMessageText({
            chatId: targetChatId,
            messageId: callbackMessageId,
            text: withOperator(
              resumed
                ? `📝 Borrador retomado: ${draft.months} mes(es) (paso 2 de 2). Confirma o cancela.`
                : '📝 Borrador MOCK abierto (paso 1 de 2). Envía la corrección o confirma.',
              targetActorName,
            ),
            replyMarkup: draftKeyboard(operation.id),
          });
        } else {
          await deps.client.sendMessage({
            chatId: targetChatId,
            text: withOperator(
              resumed
                ? `📝 Borrador retomado: ${draft.months} mes(es) (paso 2 de 2). Confirma o cancela.`
                : '📝 Borrador MOCK abierto (paso 1 de 2). Envía la corrección o confirma.',
              targetActorName,
            ),
            replyMarkup: draftKeyboard(operation.id),
          });
        }
        if (callbackId !== undefined) {
          await deps.client.answerCallbackQuery(callbackId);
        }
        return;
      }
      if (action === 'vencidos') {
        const expired = await deps.repos.getExpiredAccounts();
        const view = createInteraction('EXPIRED');
        persistAll();
        await sendLabeled(
          expired.length === 0
            ? '⏰ Sin vencidos MOCK.'
            : `⏰ Vencidos MOCK (${expired.length}):\n${formatRows(expired.slice(0, 5))}`,
          sectionKeyboard('vencidos', view.id),
        );
        return;
      }
      if (action === 'inventario') {
        const summary = await deps.repos.getInventorySummary();
        const lines = summary.map((row) => `• ${row.servicio}: ${row.total}`);
        const view = createInteraction('INVENTORY');
        persistAll();
        await sendLabeled(
          lines.length === 0 ? '📦 Inventario MOCK vacío.' : `📦 Inventario MOCK:\n${lines.join('\n')}`,
          sectionKeyboard('inventario', view.id),
        );
        return;
      }
      if (action === 'confirm' || action === 'cancel') {
        const kind = action as 'confirm' | 'cancel';
        if (interaction.status !== 'PENDING') {
          // Idempotent repeats: no loop, no recreation, no extra mutation.
          const text =
            interaction.status === 'CANCELLED'
              ? CANCELLED_TEXT
              : kind === 'confirm'
                ? '✅ Operación MOCK confirmada'
                : 'Sin borrador abierto que cancelar.';
          const home = createInteraction('HOME');
          persistAll();
          await sendLabeled(text, homeKeyboard(home.id));
          return;
        }
        const result = kind === 'confirm' ? confirmOrCancel('confirm') : cancelWithIdempotency();
        if (result.ok) {
          if (kind === 'confirm') {
            deps.interactions.confirm(interaction.id);
          } else {
            deps.interactions.cancel(interaction.id);
          }
        }
        persistAll();
        const home = createInteraction('HOME');
        persistAll();
        await sendLabeled(result.text, homeKeyboard(home.id));
        return;
      }
      if (action === 'correct') {
        const blocked = correctGuard();
        if (blocked !== null) {
          const home = createInteraction('HOME');
          persistAll();
          await sendLabeled(blocked.text, homeKeyboard(home.id));
          return;
        }
        deps.interactions.touch(interaction.id, { view: 'correct' });
        persistAll();
        await sendLabeled(CORRECTION_PROMPT_TEXT, draftKeyboard(interaction.id));
        return;
      }
      const viewIndex = viewIndexFor(action);
      if (viewIndex !== null) {
        const query =
          typeof interaction.state['query'] === 'string'
            ? (interaction.state['query'] as string)
            : '';
        const offset =
          typeof interaction.state['offset'] === 'number'
            ? (interaction.state['offset'] as number)
            : 0;
        await renderAccountDetail(interaction, query, offset + viewIndex);
        return;
      }
      if (action === 'next' || action === 'prev') {
        const query =
          typeof interaction.state['query'] === 'string'
            ? (interaction.state['query'] as string)
            : '';
        const offset =
          typeof interaction.state['offset'] === 'number'
            ? (interaction.state['offset'] as number)
            : 0;
        deps.interactions.touch(interaction.id, {
          offset:
            action === 'next' ? offset + SEARCH_PAGE_SIZE : offset - SEARCH_PAGE_SIZE,
        });
        await renderSearchPage(deps.interactions.get(interaction.id) ?? interaction, query);
        return;
      }
      const sectionText = SECTION_TEXTS[action] ?? SECTION_TEXTS['mas'] ?? '⋯ MÁS (demo)';
      const view = createInteraction('MORE');
      persistAll();
      await sendLabeled(sectionText, sectionKeyboard(action, view.id));
    }

    if (decision.layer === 'noop') {
      await ackStale(
        typeof callbackData === 'string' ? callbackData : undefined,
      );
      return { ok: true };
    }

    if (decision.layer === 'L1') {
      const action = decision.action;
      const interactionId = decision.interactionId;
      if (interactionId !== undefined) {
        const interaction = resolveOwnedInteraction(interactionId);
        if (interaction === undefined) {
          // Stale callback (redeploy with a fresh store, forged id…).
          await ackStale(action);
          return { ok: true };
        }
        if (interaction.chatId !== targetChatId) {
          await rejectTap(interaction, action);
          return { ok: true };
        }
        if (interaction.ownerTelegramUserId !== targetActorId) {
          // Cross-actor tap: reject with the toast, execute NOTHING —
          // no edit, no state mutation, no navigation.
          await rejectTap(interaction, action);
          return { ok: true };
        }
        await executeOwned(action, interaction);
        return { ok: true };
      }
      // Legacy unbound buttons: per-actor behavior, freshly owned replies.
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
        persistAll();
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
        const result = cancelWithIdempotency();
        await respondDraft(result.text, true);
        return { ok: true };
      }
      if (action === 'correct') {
        const blocked = correctGuard();
        if (blocked !== null) {
          await respondDraft(blocked.text, true);
          return { ok: true };
        }
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
          const result = cancelWithIdempotency();
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
      if (
        parse.kind === 'phone' ||
        parse.kind === 'email' ||
        parse.kind === 'service' ||
        parse.kind === 'account'
      ) {
        // Per-requester search interaction: result buttons reject the peer;
        // the peer starts their own search. Both coexist.
        // The `account` kind is the neutral ACCOUNT_IDENTIFIER — the
        // returned servicio comes from the data row, never assumed.
        const interaction = createInteraction('SEARCH', { view: 'list', offset: 0 });
        await renderSearchPage(interaction, parse.value);
        return { ok: true };
      }
      if (parse.kind === 'months') {
        // Text input consults ONLY this operator's draft — a peer's
        // pendingInput is never filled, never read, never mutated here.
        const updated = deps.drafts.update(owner, { months: parse.months });
        if (updated === undefined) {
          await respond(NO_DRAFT_TEXT);
          return { ok: true };
        }
        persistAll();
        auditDraft('draft.updated', { months: updated.months });
        await respondDraft(
          `${DRAFT_UPDATED_PREFIX} ${updated.months} mes(es) (paso 2 de 2). Confirma o cancela.`,
        );
        return { ok: true };
      }
      await respond(UNKNOWN_TEXT);
      return { ok: true };
    }

    // L3 — Gemini intent only; execution stays deterministic. The model
    // receives ONLY this actor's identity — never group mutable session.
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
      persistAll();
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
      persistAll();
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

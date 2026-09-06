import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IntentInterpreter } from '../ai/intentInterpreter';
import { isAuthorized, isAuthorizedChat } from '../auth/allowlist';
import { type Auditor, createAuditor } from '../audit/audit';
import { AlertService } from '../alerts/alerts';
import type { Env } from '../config/env';
import { DraftEngine, type DraftOwner, type DraftResult } from '../drafts/engine';
import {
  AccountSelectionStore,
  formatAccountCard,
  type ServiceAccount,
} from '../mock/accounts';
import {
  CustomerSelectionStore,
  formatCustomerCard,
  type Customer,
} from '../mock/customers';
import {
  InteractionStore,
  type Interaction,
  type InteractionType,
} from '../interactions/interactions';
import type { MockRepositories, SafeAccount } from '../mock/repositories';
import type { CredentialBundle } from '../mock/credentials';
import type { MockService } from '../mock/excelLoader';
import { credentialOptionLabel, resolveCredentialView } from '../tools/credentials';
import { containsPhoneCandidate, extractEmbeddedAccount, isExplicitCreateRequest } from '../parser/fast';
import { route } from '../router/hybrid';
import { SessionStore } from '../session/store';
import {
  ASK_ACCOUNT_TEXT,
  pickSearchIdentifier,
  resolveMissingFields,
} from '../tools/requirements';
import { logger } from '../utils/logger';
import {
  HOME_TEXT,
  SECTION_TEXTS,
  accountDisambiguationKeyboard,
  accountSearchKeyboard,
  credentialDisambiguationKeyboard,
  draftKeyboard,
  homeKeyboard,
  phoneSearchKeyboard,
  searchResultsKeyboard,
  sectionKeyboard,
  withOperator,
  type CallbackAction,
} from './keyboards';
import type { TelegramClient, TelegramContext } from './client';
import {
  esc,
  expiredRow,
  renderAccountChoices,
  renderAccountNotFound,
  renderActivitySummary,
  renderCredentialCard,
  renderCredentialChoices,
  renderCredentialNoContext,
  renderCustomerList,
  renderDraftCreated,
  renderDraftOpened,
  renderDraftResumed,
  renderDraftUpdated,
  renderExpired,
  renderInventory,
  renderLegacyDetail,
  renderLegacyList,
  renderLegacyNotFound,
  renderOwnershipWarning,
  renderPhoneNotFound,
  unesc,
} from './render';
import {
  alertsOnlyText,
  findTopicOwner,
  type OperatorTopics,
  resolveDisplayName,
  topicGuideText,
  topicMismatchText,
} from './topics';

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** Neutral reply for non-allowlisted users — no tools, no Gemini, no MOCK. */
export const UNAUTHORIZED_TEXT = '⛔ No tienes acceso a Vokath.';
export const UNKNOWN_TEXT = '❓ No entendí — usa los botones o /start.';
export const NO_RESULTS_TEXT = '🔎 Sin resultados MOCK.';
/**
 * Read-only phone not-found (BR-CUS-008): report + offer retry/volver.
 * NEVER "Crear cliente" — creation belongs exclusively to the explicit
 * new-sale flow (BR-CUS-009).
 */
export const PHONE_NOT_FOUND_TEXT = renderPhoneNotFound();
/**
 * Read-only account not-found (BR-ACC-004): report + offer retry/volver.
 * NEVER anything else — unknown identifiers are reported, never
 * created, and searches never touch drafts.
 */
export const ACCOUNT_NOT_FOUND_TEXT = renderAccountNotFound();
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
  return `⚠️ Este requerimiento pertenece a ${esc(ownerName)}.`;
}

/**
 * Extracts the owner display name from a bot message carrying the
 * `👤 Operador: <nombre>` label. Returns undefined for unlabeled
 * (pre-ownership or non-interactive) messages, which impose no reply guard.
 * The label name is HTML-escaped at render time, so it is decoded back
 * here — plain names round-trip byte-identical.
 */
export function parseOperatorLabel(text: string | undefined): string | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }
  const match = /👤 Operador:\s*([^\n]+)/u.exec(text);
  const name = match?.[1]?.trim();
  if (name === undefined || name === '') {
    return undefined;
  }
  return unesc(name);
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
  /**
   * Forum operator→topic map. Empty/undefined = Mode A (current
   * group-first behavior, unchanged). Configured = Mode B: mapped
   * operators may only act inside their assigned topic.
   */
  operatorTopics?: OperatorTopics;
  /** Forum topic receiving the single allowed activity summary. Undefined = disabled. */
  activityTopicId?: number;
  /**
   * Forum topic receiving critical alerts (⭐ Alertas). Undefined =
   * disabled: /testalert degrades to a guide reply and nothing breaks.
   */
  alertsTopicId?: number;
  /** File path for best-effort draft persistence; undefined disables it. */
  draftsStatePath?: string;
  /** File path for best-effort interaction persistence; undefined disables it. */
  interactionsStatePath?: string;
  /** File path for best-effort OperatorProfile persistence; undefined disables it. */
  operatorProfilesStatePath?: string;
}

interface TelegramUser {
  id?: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id?: number;
  /**
   * Chat type (`private`, `group`, `supergroup`, `channel`). Forum groups
   * arrive as `supergroup` (with `is_forum: true` when topics are
   * enabled). There is intentionally NO type gate here: every authorized
   * chat type is accepted — the topic only selects the reply thread.
   */
  type?: string;
  /** True for forum groups with topics enabled. Accepted like any other chat. */
  is_forum?: boolean;
}

interface TelegramMessage {
  message_id?: number;
  /** Forum topic id (`message_thread_id` on the wire). Absent in Mode A. */
  message_thread_id?: number;
  from?: TelegramUser;
  chat?: TelegramChat;
  text?: string;
  reply_to_message?: TelegramMessage;
  /**
   * Group→supergroup migration markers. Telegram reassigns chat.id on
   * migration: the old scope is dead and its interactions must never leak
   * into the new scope (see migration guard below).
   */
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
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
  * side-channels) → /topicid diagnostic exception (auth-gated,
  * side-effect-free) → CENTRAL TOPIC-OWNERSHIP GUARD (Mode B) →
  * /testalert (under the guard) → update_id idempotency → per-actor
  * session touch → reply-ownership guard → L1/L2/L3 cascade → Telegram
  * reply. Rejected updates touch nothing: no session, no draft, no
  * interaction, no Gemini, no MOCK.
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
    /**
     * Group→supergroup migration: Telegram delivers a service message
     * carrying `migrate_to_chat_id` / `migrate_from_chat_id` and the chat
     * gets a NEW id. The old chat scope (its sessions, drafts,
     * interactions) is dead — resolving it under the new id would leak one
     * chat's state into another. Ack without touching anything; the next
     * real update establishes the new scope on demand. Never crashes.
     */
    if (
      typeof message?.migrate_to_chat_id === 'number' ||
      typeof message?.migrate_from_chat_id === 'number'
    ) {
      logger.info(
        {
          chatId: message?.chat?.id,
          migrateTo: message?.migrate_to_chat_id,
          migrateFrom: message?.migrate_from_chat_id,
        },
        'Ignored group migration service message',
      );
      return { ok: true };
    }
    // Operator identity ALWAYS comes from `from.id` — never from chat.id.
    // `chat.id` + `message_thread_id` + `from.id` are captured together on
    // EVERY update: chatId alone never suffices to route a forum reply.
    const actorId = callback?.from?.id ?? message?.from?.id;
    const chatId = callback?.message?.chat?.id ?? message?.chat?.id;
    if (actorId === undefined || chatId === undefined) {
      return { ok: true };
    }
    // Forum thread from the incoming message (Mode B). NEVER replaces the
    // owner — every gate below validates BOTH actorId AND thread.
    // General has no thread id (undefined) — never hardcoded, never assumed.
    const actorThreadId =
      message?.message_thread_id ?? callback?.message?.message_thread_id;
    /**
     * Centralized early reply context: every rejection below answers
     * through this ONE context so the origin topic can never be lost by a
     * call site that only remembered chatId. Undefined thread = General
     * (or non-forum chat) — the only case where no thread is sent.
     */
    const earlyCtx: TelegramContext = {
      chatId: chatId as number,
      ...(actorThreadId !== undefined ? { messageThreadId: actorThreadId } : {}),
      ...(actorId !== undefined ? { actorTelegramUserId: actorId } : {}),
    };
    /** Early rejection send: always returns to the origin topic. */
    async function sendEarly(text: string): Promise<void> {
      await deps.client.sendMessage({
        chatId: earlyCtx.chatId,
        text,
        ...(earlyCtx.messageThreadId !== undefined
          ? { messageThreadId: earlyCtx.messageThreadId }
          : {}),
      });
    }
    const fromUser = callback?.from ?? message?.from;
    /**
     * Pre-auth display name: READ-ONLY (touches nothing — rejected updates
     * leave zero trace: no session, no draft, no interaction, no profile,
     * no Gemini, no MOCK). Operator alias when one exists → live
     * first_name + last_name → @username → bare `Usuario`: never empty,
     * never id-leaking.
     */
    const storedAlias = deps.interactions.resolveNameByUserId(chatId, actorId);
    const preAuthName = resolveDisplayName({
      ...(storedAlias !== undefined ? { alias: storedAlias } : {}),
      ...(fromUser?.first_name !== undefined ? { firstName: fromUser.first_name } : {}),
      ...(fromUser?.last_name !== undefined ? { lastName: fromUser.last_name } : {}),
      ...(fromUser?.username !== undefined ? { username: fromUser.username } : {}),
      userId: actorId,
    });

    if (!isAuthorized(deps.allowlist, actorId)) {
      logger.info({ userId: actorId, chatId, updateId }, 'Rejected unauthorized Telegram user');
      auditor.record({
        chatId,
        actorTelegramUserId: actorId,
        actorName: preAuthName,
        actionType: 'auth.rejected_user',
        ...(updateId !== undefined ? { metadata: { updateId } } : {}),
      });
      await sendEarly(UNAUTHORIZED_TEXT);
      return { ok: true };
    }

    if (!isAuthorizedChat(deps.chatAllowlist, chatId)) {
      logger.info({ userId: actorId, chatId, updateId }, 'Rejected unauthorized Telegram chat');
      auditor.record({
        chatId,
        actorTelegramUserId: actorId,
        actorName: preAuthName,
        actionType: 'auth.rejected_chat',
        ...(updateId !== undefined ? { metadata: { updateId } } : {}),
      });
      await sendEarly(UNAUTHORIZED_TEXT);
      return { ok: true };
    }

    /**
     * OperatorProfile upsert: EVERY authorized update (message AND
     * callback_query.from) creates-or-refreshes the profile from live
     * Telegram `from` fields. userId stays the ONLY security/ownership
     * key; the profile only feeds display names. From here on, actorName
     * is the central resolution used by EVERY render (labels, toasts,
     * guides, alerts, topic names) — never empty, never id-leaking.
     */
    const profile = deps.interactions.upsertOperatorProfile(chatId, {
      id: actorId,
      ...(fromUser?.first_name !== undefined ? { first_name: fromUser.first_name } : {}),
      ...(fromUser?.last_name !== undefined ? { last_name: fromUser.last_name } : {}),
      ...(fromUser?.username !== undefined ? { username: fromUser.username } : {}),
    });
    const actorName: string = profile?.displayName ?? preAuthName;

    const operatorTopics: OperatorTopics = deps.operatorTopics ?? new Map();
    const modeB = operatorTopics.size > 0;

    /**
     * DOCUMENTED EXCEPTION — /topicid (OWNER-only diagnostic: authorized
     * operators only, since user+chat auth already passed above). It runs
     * AFTER auth but is EXEMPT from the topic-ownership guard below, so it
     * keeps working in General and in any topic. It creates no
     * interaction, no draft, no session touch, no MockStore write, no
     * Gemini call, and no business audit — the ONLY side effect is the
     * reply itself, answered back into the origin topic through sendEarly.
     * Message text only, never callbacks. It must NOT become a router
     * bypass: no state, no Gemini — keep as is.
     *
     * Diagnostic privilege: this is the ONE normal path allowed to show a
     * raw id (`Usuario <id>` when the bound owner has no stored profile),
     * because the reply already prints Chat/Thread ids for debugging.
     */
    if (callback === undefined) {
      const firstToken = (message?.text?.trim().split(/\s+/)[0] ?? '')
        .split('@')[0]
        ?.toLowerCase();
      if (firstToken === '/topicid') {
        let topicLabel: string;
        if (actorThreadId === undefined) {
          topicLabel = 'General';
        } else {
          const boundOwnerId = findTopicOwner(operatorTopics, actorThreadId);
          if (boundOwnerId === undefined) {
            topicLabel = '(desconocido)';
          } else {
            const storedBound = deps.interactions.resolveNameByUserId(
              chatId,
              boundOwnerId,
            );
            // Diagnostic fallback keeps the raw id visible on purpose.
            topicLabel = storedBound ?? `Usuario ${boundOwnerId}`;
          }
        }
        await sendEarly(
          `🧵 Información del topic\n\nTopic: ${esc(topicLabel)}\nChat ID: ${String(chatId)}\nThread ID: ${actorThreadId === undefined ? 'general / none' : String(actorThreadId)}`,
        );
        return { ok: true };
      }
    }

    /**
     * CENTRAL TOPIC-OWNERSHIP GUARD (Mode B only — skipped when no
     * mapping is configured, i.e. Mode A unchanged).
     *
     * Position: Telegram Update → user auth → chat auth → THIS GUARD →
     * (/topicid exception above, /testalert below) → router/parser/
     * Gemini/tools/drafts/alerts. The router only ever sees updates this
     * guard cleared.
     *
     * Bypass audit (every path verified to flow through this guard):
     * - /topicid is the ONLY exemption (documented above, auth-gated,
     *   side-effect-free).
     * - /testalert used to run BEFORE the gate (executed from another
     *   operator's topic) — it now sits BELOW the guard.
     * - Early commands (/start), free text, fast-parser hits and Gemini
     *   fallback all flow through `route()` below the guard.
     * - Callbacks (buttons) carry no text so they never matched the
     *   diagnostic branch; they hit this guard via the tap thread, then
     *   the interaction owner/thread/chat checks in L1.
     * - Replies to peer messages and pending-input consumption happen
     *   below the guard — a cross-topic update never reaches them.
     * - AlertService publishing is infrastructure (no Telegram update),
     *   so it is unaffected by this guard by design.
     *
     * Rule: a mapped operator may act ONLY inside their assigned topic.
     * The alerts topic and General are never operational for users.
     * Rejections execute NOTHING: no session, no draft, no interaction,
     * no Gemini, no MOCK — just the guide reply.
     */
    if (modeB) {
      // Alerts thread (TELEGRAM_ALERTS_TOPIC_ID): NOT operational. Any
      // operation attempt there (/start, /testalert, search, operar,
      // text, callbacks) gets the alerts-only reply and nothing executes.
      if (deps.alertsTopicId !== undefined && actorThreadId === deps.alertsTopicId) {
        auditor.record({
          chatId,
          actorTelegramUserId: actorId,
          actorName,
          actionType: 'topic.blocked_alerts_thread',
          ...(updateId !== undefined
            ? { metadata: { threadId: actorThreadId, updateId } }
            : { metadata: { threadId: actorThreadId } }),
        });
        await sendEarly(alertsOnlyText());
        return { ok: true };
      }
      const assignedThread = operatorTopics.get(actorId);
      if (assignedThread !== undefined) {
        if (actorThreadId === undefined) {
          // Outside every assigned topic (General — its id is never
          // assumed): personal guide, never operate.
          auditor.record({
            chatId,
            actorTelegramUserId: actorId,
            actorName,
            actionType: 'topic.blocked_outside',
            ...(updateId !== undefined ? { metadata: { updateId } } : {}),
          });
          await sendEarly(topicGuideText(actorName));
          return { ok: true };
        }
        if (actorThreadId !== assignedThread) {
          const threadOwnerId = findTopicOwner(operatorTopics, actorThreadId);
          if (threadOwnerId !== undefined) {
            /**
             * Owner-name resolution: OperatorProfile store first (the
             * owner may never have interacted, so the guard holds no
             * `from` fields for them). getChatMember ONLY on a store
             * miss — last resort, then persisted — never per message.
             * Offline test stubs omit getChatMember and skip cleanly.
             */
            const getMember = deps.client.getChatMember?.bind(deps.client);
            const threadOwnerName = await deps.interactions.resolveOwnerDisplayName(
              chatId,
              threadOwnerId,
              getMember !== undefined
                ? {
                    fetcher: (userId) => getMember(chatId, userId),
                  }
                : undefined,
            );
            auditor.record({
              chatId,
              actorTelegramUserId: actorId,
              actorName,
              actionType: 'topic.blocked_cross_thread',
              metadata: {
                threadId: actorThreadId,
                ownerUserId: threadOwnerId,
                ownerName: threadOwnerName,
              },
            });
            await deps.client.sendMessage({
              chatId,
              text: topicMismatchText(threadOwnerName, actorName),
              messageThreadId: actorThreadId,
            });
            return { ok: true };
          }
          auditor.record({
            chatId,
            actorTelegramUserId: actorId,
            actorName,
            actionType: 'topic.blocked_outside',
            ...(updateId !== undefined ? { metadata: { threadId: actorThreadId, updateId } } : { metadata: { threadId: actorThreadId } }),
          });
          await deps.client.sendMessage({
            chatId,
            text: topicGuideText(actorName),
            messageThreadId: actorThreadId,
          });
          return { ok: true };
        }
      }
    }

    /**
     * /testalert — fully UNDER the guard above: it only works from the
     * actor's own topic (Mode B) and the alert still routes to the alerts
     * thread. Creates no interaction, no draft, no session touch, no
     * Gemini call — the ONLY side effects are the alert post and the
     * confirmation reply. Message text only, never callbacks.
     */
    if (callback === undefined) {
      const firstToken = (message?.text?.trim().split(/\s+/)[0] ?? '')
        .split('@')[0]
        ?.toLowerCase();
      if (firstToken === '/testalert') {
        if (deps.alertsTopicId === undefined) {
          logger.info(
            { userId: actorId, chatId },
            'Alerts topic not configured — /testalert skipped',
          );
          await sendEarly('⚠️ Topic de Alertas no configurado (TELEGRAM_ALERTS_TOPIC_ID).');
          return { ok: true };
        }
        const alerts = new AlertService(deps.client);
        await alerts.sendCriticalAlert(
          { chatId, alertsThreadId: deps.alertsTopicId },
          {
            type: 'test',
            title: 'ALERTA DE PRUEBA',
            summary: 'Vorkath puede enviar alertas correctamente.',
            actorName,
            timestamp: new Date().toISOString(),
          },
        );
        await sendEarly('✅ Alerta de prueba enviada.');
        return { ok: true };
      }
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
    /** Forum thread of this update (Mode B match, or any Mode A thread). Replies echo it. */
    const targetThreadId: number | undefined = actorThreadId;
    /**
     * Centralized reply context for this update: EVERY fresh message
     * derived from it (replies, errors, ownership rejections, search
     * results, drafts, confirmations) is sent through `sendInContext`,
     * which carries the origin topic automatically. No handler hand-rolls
     * `messageThreadId` per call site — the context does it once.
     * Undefined thread = General / non-forum chat (correct, never forced).
     */
    const replyCtx: TelegramContext = {
      chatId: targetChatId,
      ...(targetThreadId !== undefined ? { messageThreadId: targetThreadId } : {}),
      actorTelegramUserId: targetActorId,
    };
    /**
     * Centralized send: resolves the effective topic as
     * `threadOverride ?? replyCtx.messageThreadId`. Callback-derived
     * messages pass the owning interaction's stored thread as the
     * override, so a new message born from a tap returns to the
     * interaction's topic even when the callback payload carries no
     * thread (legacy/stale). (answerCallbackQuery itself needs no thread.)
     */
    async function sendInContext(
      text: string,
      opts?: {
        replyMarkup?: Parameters<TelegramClient['sendMessage']>[0]['replyMarkup'];
        threadOverride?: number;
      },
    ): Promise<void> {
      const thread = opts?.threadOverride ?? replyCtx.messageThreadId;
      await deps.client.sendMessage({
        chatId: replyCtx.chatId,
        text,
        ...(opts?.replyMarkup !== undefined ? { replyMarkup: opts.replyMarkup } : {}),
        ...(thread !== undefined ? { messageThreadId: thread } : {}),
      });
    }
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
          await sendInContext(replyBelongsText(labelName));
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
        ...(targetThreadId !== undefined ? { messageThreadId: targetThreadId } : {}),
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
      if (deps.operatorProfilesStatePath !== undefined) {
        deps.interactions.saveProfilesToFile(deps.operatorProfilesStatePath).catch((error) => {
          logger.warn({ error }, 'OperatorProfile persist failed');
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
          ...(targetThreadId !== undefined ? { messageThreadId: targetThreadId } : {}),
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
        // Owner warning: profile store first, never a stored numeric id.
        const confirmOwner =
          deps.interactions.resolveOwnerLabelSync(
            targetChatId,
            peer.userId,
            peer.ownerName,
          ) ?? 'otro operador';
        return {
          ok: false,
          text: renderOwnershipWarning(confirmOwner),
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

    /**
     * The ONE allowed activity event: a secrets-free summary of a
     * confirmed operation, published into the optional activity topic.
     * Name + month count only — NEVER passwords, PINs, or credentials.
     * Disabled when no activity topic is configured. Navigation,
     * per-message noise, and every other event stay out of the topic.
     */
    async function publishConfirmedActivity(): Promise<void> {
      if (deps.activityTopicId === undefined) {
        return;
      }
      const confirmed = deps.drafts.get(owner);
      const months = confirmed?.months;
      const summary = renderActivitySummary(actorName, months);
      await deps.client.sendMessage({
        chatId: targetChatId,
        text: summary,
        messageThreadId: deps.activityTopicId,
      });
      auditDraft('activity.published', { ...(months !== undefined ? { months } : {}) });
    }

    /** Confirm path that also emits the activity summary on success. */
    async function confirmWithActivity(): Promise<DraftResult> {
      const result = confirmOrCancel('confirm');
      if (result.ok) {
        await publishConfirmedActivity();
      }
      return result;
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
        // Owner warning: profile store first, never a stored numeric id.
        const correctOwner =
          deps.interactions.resolveOwnerLabelSync(
            targetChatId,
            peer.userId,
            peer.ownerName,
          ) ?? 'otro operador';
        return {
          ok: false,
          text: renderOwnershipWarning(correctOwner),
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
      // Owner toast: profile store first, never a stored numeric id.
      const ownerName =
        interaction !== undefined
          ? deps.interactions.resolveOwnerLabelSync(
              targetChatId,
              interaction.ownerTelegramUserId,
              interaction.ownerName,
            )
          : undefined;
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

    /**
     * Labeled send-or-edit: every interactive message shows its operator.
     * Fresh messages return to the origin topic through the centralized
     * context; `threadOverride` (the owning interaction's stored thread)
     * wins when given, so callback-derived messages keep the
     * interaction's topic even if the tap carried no thread. Edits stay
     * in place (Telegram keeps the edited message in its topic).
     */
    async function sendLabeled(
      responseText: string,
      replyMarkup:
        | ReturnType<typeof homeKeyboard>
        | ReturnType<typeof sectionKeyboard>
        | ReturnType<typeof draftKeyboard>
        | ReturnType<typeof searchResultsKeyboard>,
      threadOverride?: number,
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
        const thread = threadOverride ?? replyCtx.messageThreadId;
        await deps.client.sendMessage({
          chatId: targetChatId,
          text: labeled,
          replyMarkup,
          ...(thread !== undefined ? { messageThreadId: thread } : {}),
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
          ...(targetThreadId !== undefined ? { messageThreadId: targetThreadId } : {}),
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

    /** Actor's latest PENDING OPERATION/DRAFT interaction in this thread, if any. */
    function activeOperationInteraction(): Interaction | undefined {
      const active = deps.interactions.getActive(targetChatId, targetActorId, targetThreadId);
      if (
        active !== undefined &&
        (active.type === 'OPERATION' || active.type === 'DRAFT')
      ) {
        return active;
      }
      return undefined;
    }

    /**
     * Resolves a conversational reference ("esa misma…") to the actor's
     * OWN latest searched query (latest PENDING SEARCH interaction with
     * a stored query, same thread scope). Never consults a peer's
     * context: chatId + owner + thread must all match. Returns
     * undefined when the actor has no searchable context — the caller
     * then asks only for the identifier.
     */
    function resolveOwnSearchQuery(): string | undefined {
      let best: Interaction | undefined;
      for (const candidate of deps.interactions.snapshot()) {
        if (
          candidate.chatId !== targetChatId ||
          candidate.ownerTelegramUserId !== targetActorId ||
          candidate.type !== 'SEARCH' ||
          candidate.status !== 'PENDING'
        ) {
          continue;
        }
        if (
          targetThreadId !== undefined &&
          candidate.messageThreadId !== undefined &&
          candidate.messageThreadId !== targetThreadId
        ) {
          continue;
        }
        const query = candidate.state['query'];
        if (typeof query !== 'string' || query.trim() === '') {
          continue;
        }
        if (best === undefined || candidate.updatedAt >= best.updatedAt) {
          best = candidate;
        }
      }
      const resolved = best?.state['query'];
      return typeof resolved === 'string' ? resolved.trim() : undefined;
    }

    /**
     * THE shared deterministic search entry: parameterized NL and the
     * guided wizard's eventual input converge here (one SEARCH
     * interaction per request, then the repo seam). Complete reads
     * execute immediately with NO confirmation. Phone-like identifiers
     * take the read-only customer UX (card/list/not-found, drafts
     * untouched); neutral account identifiers (email/username/code)
     * take the read-only account UX (grouped card/disambiguation/
     * not-found, drafts untouched); bare service words keep the
     * legacy service-row browse.
     */
    async function runDirectSearch(identifier: string, serviceBrowse = false): Promise<void> {
      // Per-requester search interaction: result buttons reject the peer;
      // the peer starts their own search. Both coexist.
      if (!serviceBrowse && containsPhoneCandidate(identifier)) {
        const interaction = createInteraction('SEARCH', { view: 'customer-list', offset: 0 });
        await renderCustomerSearch(interaction, identifier);
        return;
      }
      if (!serviceBrowse) {
        const interaction = createInteraction('SEARCH', { view: 'account-list', offset: 0 });
        await renderAccountSearch(interaction, identifier);
        return;
      }
      const interaction = createInteraction('SEARCH', { view: 'list', offset: 0 });
      await renderSearchPage(interaction, identifier);
    }

    /** Last-selected customer per actor (future "ese cliente" reference). */
    const selections = new CustomerSelectionStore();

    function rememberCustomerSelection(customer: Customer): void {
      selections.select(targetChatId, targetActorId, customer);
    }

    /** Last-selected account per actor (future "esa cuenta" reference). */
    const accountSelections = new AccountSelectionStore();

    function rememberAccountSelection(account: ServiceAccount): void {
      accountSelections.select(targetChatId, targetActorId, account);
    }

    /**
     * Read-only neutral account search UX (BR-ACC-004): 0 → not-found +
     * [Buscar otra][Volver] (never anything created); 1 → direct
     * grouped card; N (same identifier in Netflix AND FlujoTV) →
     * minimal owned disambiguation (`Netflix · x` / `FlujoTV · x`),
     * then the selected card. Read-only: drafts are never created,
     * updated, or cancelled here.
     */
    async function renderAccountSearch(interaction: Interaction, query: string): Promise<void> {
      const accounts = await deps.repos.searchServiceAccounts(query);
      const total = accounts.length;
      if (total === 0) {
        deps.interactions.touch(interaction.id, { query, offset: 0, view: 'account-list' });
        persistAll();
        await sendLabeled(
          ACCOUNT_NOT_FOUND_TEXT,
          accountSearchKeyboard(interaction.id),
          interaction.messageThreadId,
        );
        return;
      }
      if (total === 1) {
        const only = accounts[0] as ServiceAccount;
        rememberAccountSelection(only);
        deps.interactions.touch(interaction.id, {
          query,
          view: 'account-detail',
          selectedAccount: {
            id: only.id,
            servicio: only.servicio,
            identifier: only.identifier,
          },
        });
        persistAll();
        await sendLabeled(
          formatAccountCard(only),
          accountSearchKeyboard(interaction.id),
          interaction.messageThreadId,
        );
        return;
      }
      const offset =
        typeof interaction.state['offset'] === 'number'
          ? (interaction.state['offset'] as number)
          : 0;
      const safeOffset = Math.min(Math.max(offset, 0), Math.max(total - 1, 0));
      const page = accounts.slice(safeOffset, safeOffset + SEARCH_PAGE_SIZE);
      deps.interactions.touch(interaction.id, {
        query,
        offset: safeOffset,
        view: 'account-list',
        total,
      });
      persistAll();
      await sendLabeled(
        renderAccountChoices(total),
        accountDisambiguationKeyboard(
          page.map((account) => ({ servicio: account.servicio, identifier: account.identifier })),
          { interactionId: interaction.id },
        ),
        interaction.messageThreadId,
      );
    }

    /** Account card from the owned disambiguation list (stores selection). */
    async function renderAccountCard(
      interaction: Interaction,
      query: string,
      accountIndex: number,
    ): Promise<void> {
      const accounts = await deps.repos.searchServiceAccounts(query);
      const account = accounts[accountIndex];
      if (account === undefined) {
        await ackStale('view');
        return;
      }
      rememberAccountSelection(account);
      deps.interactions.touch(interaction.id, {
        query,
        view: 'account-detail',
        selectedAccount: {
          id: account.id,
          servicio: account.servicio,
          identifier: account.identifier,
        },
      });
      persistAll();
      await sendLabeled(
        formatAccountCard(account),
        accountSearchKeyboard(interaction.id),
        interaction.messageThreadId,
      );
    }

    /**
     * Read-only phone search UX (BR-CUS-005/008/009): 0 → not-found +
     * [Buscar otro][Volver] (never "Crear cliente"); 1 → direct summary
     * card; N → owner-bound disambiguation list. Read-only: drafts are
     * never created, updated, or cancelled here.
     */
    async function renderCustomerSearch(interaction: Interaction, query: string): Promise<void> {
      const customers = await deps.repos.searchCustomersByPhone(query);
      const total = customers.length;
      if (total === 0) {
        deps.interactions.touch(interaction.id, { query, offset: 0, view: 'customer-list' });
        persistAll();
        await sendLabeled(
          PHONE_NOT_FOUND_TEXT,
          phoneSearchKeyboard(interaction.id),
          interaction.messageThreadId,
        );
        return;
      }
      if (total === 1) {
        const only = customers[0] as Customer;
        rememberCustomerSelection(only);
        deps.interactions.touch(interaction.id, {
          query,
          view: 'customer-detail',
          selectedCustomer: { id: only.id, nombre: only.nombre },
        });
        persistAll();
        await sendLabeled(
          formatCustomerCard(only),
          phoneSearchKeyboard(interaction.id),
          interaction.messageThreadId,
        );
        return;
      }
      const offset =
        typeof interaction.state['offset'] === 'number'
          ? (interaction.state['offset'] as number)
          : 0;
      const safeOffset = Math.min(Math.max(offset, 0), Math.max(total - 1, 0));
      const page = customers.slice(safeOffset, safeOffset + SEARCH_PAGE_SIZE);
      deps.interactions.touch(interaction.id, {
        query,
        offset: safeOffset,
        view: 'customer-list',
        total,
      });
      persistAll();
      await sendLabeled(
        renderCustomerList(
          total,
          page.map((customer) => ({ nombre: customer.nombre, phones: customer.phones })),
          safeOffset,
        ),
        searchResultsKeyboard(page.length, {
          interactionId: interaction.id,
          hasNext: safeOffset + SEARCH_PAGE_SIZE < total,
          hasPrev: safeOffset > 0,
        }),
        interaction.messageThreadId,
      );
    }

    /** Customer detail from the owned disambiguation list (stores selection). */
    async function renderCustomerDetail(
      interaction: Interaction,
      query: string,
      customerIndex: number,
    ): Promise<void> {
      const customers = await deps.repos.searchCustomersByPhone(query);
      const customer = customers[customerIndex];
      if (customer === undefined) {
        await ackStale('view');
        return;
      }
      rememberCustomerSelection(customer);
      deps.interactions.touch(interaction.id, {
        query,
        view: 'customer-detail',
        selectedCustomer: { id: customer.id, nombre: customer.nombre },
      });
      persistAll();
      await sendLabeled(
        formatCustomerCard(customer),
        phoneSearchKeyboard(interaction.id),
        interaction.messageThreadId,
      );
    }

    /**
     * SHOW_CREDENTIALS shared entry (Slice A): the 🔐Datos button (L1)
     * and the explicit datos phrases (L2) plus Gemini semantic/reference
     * variants (L3) ALL converge here — same context resolution, same
     * deterministic tool, same card. Read-only: drafts are never
     * created, updated, or cancelled here; no business state is mutated.
     *
     * Context resolves from the actor's OWN selections only (the owning
     * interaction first, else the actor's latest SEARCH selection in
     * this thread scope) — never a peer's. Credentials render ONLY
     * inside the actor's authorized operating topic: this flow runs
     * strictly below the central topic-ownership guard, and every new
     * callback it introduces travels owned (topic/guard/ownership on
     * every callback). Secrets never reach logs — audit carries safe
     * refs only (`credential_view` + service/account/customer refs).
     */
    interface CredentialSelection {
      customer?: { id: string; nombre: string };
      account?: { id: string; servicio: string; identifier: string };
    }

    function readCredentialSelection(interaction: Interaction | undefined): CredentialSelection {
      if (interaction === undefined) {
        return {};
      }
      const selected = interaction.state['selectedCustomer'];
      const account = interaction.state['selectedAccount'];
      const out: CredentialSelection = {};
      if (
        typeof selected === 'object' &&
        selected !== null &&
        typeof (selected as { id?: unknown }).id === 'string' &&
        typeof (selected as { nombre?: unknown }).nombre === 'string'
      ) {
        out.customer = {
          id: (selected as { id: string }).id,
          nombre: (selected as { nombre: string }).nombre,
        };
      }
      if (
        typeof account === 'object' &&
        account !== null &&
        typeof (account as { id?: unknown }).id === 'string'
      ) {
        const typed = account as { id: string; servicio?: unknown; identifier?: unknown };
        out.account = {
          id: typed.id,
          servicio: typeof typed.servicio === 'string' ? typed.servicio : '',
          identifier: typeof typed.identifier === 'string' ? typed.identifier : '',
        };
      }
      return out;
    }

    /**
     * Resolves the actor's OWN latest credential context: the newest
     * SEARCH interaction owned by (chatId, actorId) in this thread scope
     * carrying a selected customer/account. Never consults a peer's
     * context. Returns empty when the actor selected nothing — the
     * caller then guides back to search instead of guessing.
     */
    function resolveOwnCredentialContext(): CredentialSelection {
      let best: Interaction | undefined;
      for (const candidate of deps.interactions.snapshot()) {
        if (
          candidate.chatId !== targetChatId ||
          candidate.ownerTelegramUserId !== targetActorId ||
          candidate.type !== 'SEARCH'
        ) {
          continue;
        }
        if (
          targetThreadId !== undefined &&
          candidate.messageThreadId !== undefined &&
          candidate.messageThreadId !== targetThreadId
        ) {
          continue;
        }
        const selection = readCredentialSelection(candidate);
        if (selection.customer === undefined && selection.account === undefined) {
          continue;
        }
        if (best === undefined || candidate.updatedAt >= best.updatedAt) {
          best = candidate;
        }
      }
      return readCredentialSelection(best);
    }

    /** Safe refs for credential interaction state — NEVER passwords/PIN. */
    interface CredentialRefs {
      customerId?: string;
      accountId?: string;
      serviceFilter?: MockService;
      total: number;
    }

    function credentialRefsFor(
      selection: CredentialSelection,
      serviceFilter: MockService | undefined,
      total: number,
    ): CredentialRefs {
      return {
        ...(selection.customer !== undefined ? { customerId: selection.customer.id } : {}),
        ...(selection.account !== undefined ? { accountId: selection.account.id } : {}),
        ...(serviceFilter !== undefined ? { serviceFilter } : {}),
        total,
      };
    }

    async function credentialBundlesFor(selection: CredentialSelection): Promise<CredentialBundle[]> {
      if (selection.customer !== undefined) {
        return deps.repos.getCredentialBundlesForCustomer(selection.customer.id);
      }
      if (selection.account !== undefined) {
        return deps.repos.getCredentialBundlesForAccount(selection.account.id);
      }
      return [];
    }

    function credentialAuditRef(bundle: CredentialBundle): string {
      return `credential:${bundle.service}:${bundle.accountIdentifier}`;
    }

    /** Renders ONE sensitive card + safe-ref audit (no secrets in logs). */
    async function renderCredentialDirect(
      interaction: Interaction,
      bundle: CredentialBundle,
      refs: CredentialRefs,
    ): Promise<void> {
      deps.interactions.touch(interaction.id, { ...refs, view: 'credentials-detail' });
      persistAll();
      auditor.record({
        chatId: targetChatId,
        actorTelegramUserId: targetActorId,
        ...(targetActorName !== undefined ? { actorName: targetActorName } : {}),
        actionType: 'credential.viewed',
        entity: credentialAuditRef(bundle),
        metadata: {
          service: bundle.service,
          accountRef: bundle.accountIdentifier,
          customerRef: bundle.customerName,
        },
      });
      logger.info(
        { userId: targetActorId, chatId: targetChatId, updateId, action: 'credentials-direct' },
        'Rendered credential card',
      );
      await sendLabeled(
        renderCredentialCard({
          serviceLabel: bundle.serviceLabel,
          accountIdentifier: bundle.accountIdentifier,
          accountPassword: bundle.accountPassword,
          profile: bundle.profile,
          accountType: bundle.accountType,
          customerName: bundle.customerName,
          ...(bundle.pin !== undefined ? { pin: bundle.pin } : {}),
        }),
        accountSearchKeyboard(interaction.id),
        interaction.messageThreadId,
      );
    }

    /** Minimal disambiguation over real-data options — never passwords. */
    async function renderCredentialAsk(
      interaction: Interaction,
      options: CredentialBundle[],
      refs: CredentialRefs,
    ): Promise<void> {
      const multiCustomer = new Set(options.map((option) => option.customerName)).size > 1;
      const labels = options.map((option) => credentialOptionLabel(option, multiCustomer));
      deps.interactions.touch(interaction.id, { ...refs, total: options.length, view: 'credentials-list' });
      persistAll();
      logger.info(
        { userId: targetActorId, chatId: targetChatId, updateId, action: 'credentials-ask' },
        'Rendered credential disambiguation',
      );
      await sendLabeled(
        renderCredentialChoices(options.length),
        credentialDisambiguationKeyboard(labels, { interactionId: interaction.id }),
        interaction.messageThreadId,
      );
    }

    async function runCredentialsFlow(
      origin: Interaction | undefined,
      serviceFilter?: MockService,
    ): Promise<void> {
      const fromOrigin = readCredentialSelection(origin);
      const selection =
        fromOrigin.customer !== undefined || fromOrigin.account !== undefined
          ? fromOrigin
          : resolveOwnCredentialContext();
      const bundles = await credentialBundlesFor(selection);
      if (bundles.length === 0) {
        const view = createInteraction('SEARCH', { view: 'prompt' });
        persistAll();
        await sendLabeled(
          renderCredentialNoContext(),
          sectionKeyboard('buscar', view.id),
          view.messageThreadId,
        );
        return;
      }
      const interaction = createInteraction('SEARCH', { view: 'credentials-list', offset: 0 });
      let view = resolveCredentialView(bundles, serviceFilter);
      if (view.kind === 'none' && serviceFilter !== undefined) {
        view = resolveCredentialView(bundles, undefined);
      }
      const refs = credentialRefsFor(selection, serviceFilter, bundles.length);
      if (view.kind === 'direct') {
        await renderCredentialDirect(interaction, view.bundle, refs);
        return;
      }
      if (view.kind === 'ask') {
        await renderCredentialAsk(interaction, view.options, refs);
        return;
      }
      persistAll();
      await sendLabeled(
        renderCredentialNoContext(),
        sectionKeyboard('buscar', interaction.id),
        interaction.messageThreadId,
      );
    }

    /** Credential card from the owned disambiguation list (re-resolved, never persisted). */
    async function renderCredentialSelection(
      interaction: Interaction,
      optionIndex: number,
    ): Promise<void> {
      const state = interaction.state;
      const selection: CredentialSelection = {};
      if (typeof state['customerId'] === 'string') {
        selection.customer = { id: state['customerId'], nombre: '' };
      }
      if (typeof state['accountId'] === 'string') {
        selection.account = { id: state['accountId'], servicio: '', identifier: '' };
      }
      const storedFilter = state['serviceFilter'];
      const serviceFilter =
        storedFilter === 'netflix' || storedFilter === 'flujotv'
          ? (storedFilter as MockService)
          : undefined;
      const bundles = await credentialBundlesFor(selection);
      let view = resolveCredentialView(bundles, serviceFilter);
      if (view.kind === 'none' && serviceFilter !== undefined) {
        view = resolveCredentialView(bundles, undefined);
      }
      if (view.kind !== 'ask') {
        await ackStale('view');
        return;
      }
      const bundle = view.options[optionIndex];
      if (bundle === undefined) {
        await ackStale('view');
        return;
      }
      const refs = credentialRefsFor(selection, serviceFilter, view.options.length);
      await renderCredentialDirect(interaction, bundle, refs);
    }

    /** Rebuilds the owned disambiguation list (Volver from a card/list). */
    async function renderCredentialList(interaction: Interaction): Promise<void> {
      const state = interaction.state;
      const selection: CredentialSelection = {};
      if (typeof state['customerId'] === 'string') {
        selection.customer = { id: state['customerId'], nombre: '' };
      }
      if (typeof state['accountId'] === 'string') {
        selection.account = { id: state['accountId'], servicio: '', identifier: '' };
      }
      const storedFilter = state['serviceFilter'];
      const serviceFilter =
        storedFilter === 'netflix' || storedFilter === 'flujotv'
          ? (storedFilter as MockService)
          : undefined;
      const bundles = await credentialBundlesFor(selection);
      let view = resolveCredentialView(bundles, serviceFilter);
      if (view.kind === 'none' && serviceFilter !== undefined) {
        view = resolveCredentialView(bundles, undefined);
      }
      const refs = credentialRefsFor(selection, serviceFilter, bundles.length);
      if (view.kind === 'ask') {
        await renderCredentialAsk(interaction, view.options, refs);
        return;
      }
      if (view.kind === 'direct') {
        await renderCredentialDirect(interaction, view.bundle, refs);
        return;
      }
      persistAll();
      await sendLabeled(
        renderCredentialNoContext(),
        sectionKeyboard('buscar', interaction.id),
        interaction.messageThreadId,
      );
    }

    /**
     * Dataless buscar prompt — the SAME wizard the BUSCAR button opens.
     * Serves the L2 `buscar` section (dataless re-entry: "buscar otro
     * número", "otra cuenta") so button≡NL with zero Gemini.
     */
    async function showSearchPrompt(thread?: number): Promise<void> {
      const view = createInteraction('SEARCH', { view: 'prompt' });
      persistAll();
      await sendLabeled(
        SECTION_TEXTS['buscar'] ?? '🔎 BUSCAR',
        sectionKeyboard('buscar', view.id),
        thread ?? view.messageThreadId,
      );
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
      return rows.map((row) => expiredRow(row)).join('\n');
    }

    /**
     * THE shared section handlers — button taps (L1 bound + legacy),
     * section NL (L2) and semantic intents (L3) ALL converge here, so a
     * button and its conversational twin end in the SAME handler, the
     * SAME deterministic repo/draft call and the SAME reply. `thread`
     * carries the owning interaction's topic for callback-derived
     * messages; fresh NL uses the update's own topic.
     */
    async function openOperateDraft(thread?: number): Promise<void> {
      const resumed = deps.drafts.isOpen(owner);
      const draft = deps.drafts.create(owner, {
        ...(targetActorName !== undefined ? { ownerName: targetActorName } : {}),
      });
      const operation = activeOperationInteraction() ?? createInteraction('OPERATION');
      persistAll();
      auditDraft('draft.created', { months: draft.months, resumed });
      await sendLabeled(
        resumed ? renderDraftResumed(draft.months) : renderDraftOpened(),
        draftKeyboard(operation.id),
        thread ?? operation.messageThreadId,
      );
    }

    async function showExpired(thread?: number): Promise<void> {
      const expired = await deps.repos.getExpiredAccounts();
      const view = createInteraction('EXPIRED');
      persistAll();
      await sendLabeled(
        renderExpired(expired.slice(0, 5), expired.length),
        sectionKeyboard('vencidos', view.id),
        thread ?? view.messageThreadId,
      );
    }

    async function showInventory(thread?: number): Promise<void> {
      const summary = await deps.repos.getInventorySummary();
      const view = createInteraction('INVENTORY');
      persistAll();
      await sendLabeled(
        renderInventory(summary),
        sectionKeyboard('inventario', view.id),
        thread ?? view.messageThreadId,
      );
    }

    /** CAJA placeholder (same text as the 💰CAJA button — real logic is Fase 2+). */
    async function showCash(thread?: number): Promise<void> {
      const view = createInteraction('CASH');
      persistAll();
      await sendLabeled(
        SECTION_TEXTS['caja'] ?? '💰 CAJA',
        sectionKeyboard('caja', view.id),
        thread ?? view.messageThreadId,
      );
    }

    /** MÁS placeholder (same text as the ⋯MÁS button). */
    async function showMore(thread?: number): Promise<void> {
      const view = createInteraction('MORE');
      persistAll();
      await sendLabeled(
        SECTION_TEXTS['mas'] ?? '⋯ MÁS',
        sectionKeyboard('mas', view.id),
        thread ?? view.messageThreadId,
      );
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
        // Not-found: report + offer retry/volver. NEVER offer "Crear
        // cliente" here — creation belongs exclusively to the explicit
        // new-sale flow.
        deps.interactions.touch(interaction.id, { query, offset: 0, view: 'list' });
        persistAll();
        await sendLabeled(
          renderLegacyNotFound(query),
          sectionKeyboard('buscar', interaction.id),
          interaction.messageThreadId,
        );
        return;
      }
      const safeOffset = Math.min(Math.max(offset, 0), Math.max(total - 1, 0));
      const page = rows.slice(safeOffset, safeOffset + SEARCH_PAGE_SIZE);
      deps.interactions.touch(interaction.id, {
        query,
        offset: safeOffset,
        view: 'list',
        total,
      });
      persistAll();
      await sendLabeled(
        renderLegacyList(total, page, safeOffset),
        searchResultsKeyboard(page.length, {
          interactionId: interaction.id,
          hasNext: safeOffset + SEARCH_PAGE_SIZE < total,
          hasPrev: safeOffset > 0,
        }),
        interaction.messageThreadId,
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
        renderLegacyDetail(row, globalIndex, rows.length),
        sectionKeyboard('buscar', interaction.id),
        interaction.messageThreadId,
      );
    }

    /** Owned-callback execution: ownership already verified by the caller. */
    async function executeOwned(
      action: string,
      interaction: Interaction,
    ): Promise<void> {
      if (action === 'home' || action === 'back') {
        if (interaction.type === 'SEARCH' && interaction.state['view'] === 'account-detail') {
          // Volver from an account card: back to the owned
          // disambiguation list when one exists (N accounts), Home for
          // a direct single-card (no list to return to) — drafts and
          // persistent requirements are never deleted either way.
          const query =
            typeof interaction.state['query'] === 'string'
              ? (interaction.state['query'] as string)
              : '';
          const total =
            typeof interaction.state['total'] === 'number'
              ? (interaction.state['total'] as number)
              : 0;
          if (total > 1) {
            await renderAccountSearch(interaction, query);
            return;
          }
        } else if (
          interaction.type === 'SEARCH' &&
          interaction.state['view'] === 'customer-detail'
        ) {
          // Volver from a customer card: back to the owned
          // disambiguation list when one exists (N results), Home for a
          // direct single-card (no list to return to) — drafts and
          // persistent requirements are never deleted either way.
          const query =
            typeof interaction.state['query'] === 'string'
              ? (interaction.state['query'] as string)
              : '';
          const total =
            typeof interaction.state['total'] === 'number'
              ? (interaction.state['total'] as number)
              : 0;
          if (total > 1) {
            await renderCustomerSearch(interaction, query);
            return;
          }
        } else if (
          interaction.type === 'SEARCH' &&
          (interaction.state['view'] === 'credentials-list' ||
            interaction.state['view'] === 'credentials-detail')
        ) {
          // Volver from a credential card/list: back to the owned
          // disambiguation list when one exists (N options), Home for a
          // direct single-card (no list to return to) — drafts and
          // persistent requirements are never deleted either way.
          const total =
            typeof interaction.state['total'] === 'number'
              ? (interaction.state['total'] as number)
              : 0;
          if (total > 1) {
            await renderCredentialList(interaction);
            return;
          }
        } else if (interaction.type === 'SEARCH' && interaction.state['view'] === 'detail') {
          // Volver belongs to the interaction: back to the owned list,
          // never deleting drafts or persistent requirements.
          const query =
            typeof interaction.state['query'] === 'string'
              ? (interaction.state['query'] as string)
              : '';
          await renderSearchPage(interaction, query);
          return;
        }        // Navigation never touches drafts — both actors' state survives.
        const home = createInteraction('HOME');
        persistAll();
        await sendLabeled(HOME_TEXT, homeKeyboard(home.id), interaction.messageThreadId);
        return;
      }
      if (action === 'buscar') {
        const view = createInteraction('SEARCH', { view: 'prompt' });
        persistAll();
        await sendLabeled(
          SECTION_TEXTS['buscar'] ?? '🔎 BUSCAR',
          sectionKeyboard('buscar', view.id),
          interaction.messageThreadId,
        );
        return;
      }
      if (action === 'credentials') {
        // 🔐Datos button: the SAME deterministic SHOW_CREDENTIALS tool
        // the explicit datos phrases run (button≡NL) — ownership and
        // thread already verified by the caller.
        await runCredentialsFlow(interaction);
        return;
      }
      if (action === 'operar') {
        await openOperateDraft(interaction.messageThreadId);
        return;
      }
      if (action === 'vencidos') {
        await showExpired(interaction.messageThreadId);
        return;
      }
      if (action === 'inventario') {
        await showInventory(interaction.messageThreadId);
        return;
      }
      if (action === 'caja') {
        await showCash(interaction.messageThreadId);
        return;
      }
      if (action === 'mas') {
        await showMore(interaction.messageThreadId);
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
          await sendLabeled(text, homeKeyboard(home.id), interaction.messageThreadId);
          return;
        }
        const result = kind === 'confirm' ? await confirmWithActivity() : cancelWithIdempotency();
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
        await sendLabeled(result.text, homeKeyboard(home.id), interaction.messageThreadId);
        return;
      }
      if (action === 'correct') {
        const blocked = correctGuard();
        if (blocked !== null) {
          const home = createInteraction('HOME');
          persistAll();
          await sendLabeled(blocked.text, homeKeyboard(home.id), interaction.messageThreadId);
          return;
        }
        deps.interactions.touch(interaction.id, { view: 'correct' });
        persistAll();
        await sendLabeled(
          CORRECTION_PROMPT_TEXT,
          draftKeyboard(interaction.id),
          interaction.messageThreadId,
        );
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
        if (
          interaction.state['view'] === 'customer-list' ||
          interaction.state['view'] === 'customer-detail'
        ) {
          await renderCustomerDetail(interaction, query, offset + viewIndex);
          return;
        }
        if (
          interaction.state['view'] === 'account-list' ||
          interaction.state['view'] === 'account-detail'
        ) {
          await renderAccountCard(interaction, query, offset + viewIndex);
          return;
        }
        if (interaction.state['view'] === 'credentials-list') {
          await renderCredentialSelection(interaction, viewIndex);
          return;
        }
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
        const target = deps.interactions.get(interaction.id) ?? interaction;
        if (target.state['view'] === 'customer-list') {
          await renderCustomerSearch(target, query);
          return;
        }
        if (target.state['view'] === 'account-list') {
          await renderAccountSearch(target, query);
          return;
        }
        await renderSearchPage(target, query);
        return;
      }
      const sectionText = SECTION_TEXTS[action] ?? SECTION_TEXTS['mas'] ?? '⋯ MÁS';
      const view = createInteraction('MORE');
      persistAll();
      await sendLabeled(sectionText, sectionKeyboard(action, view.id), interaction.messageThreadId);
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
        if (
          targetThreadId !== undefined &&
          interaction.messageThreadId !== undefined &&
          interaction.messageThreadId !== targetThreadId
        ) {
          // Cross-thread tap: the interaction belongs to another topic.
          // Owner already matches, so this is forged/stale — reject with
          // the toast and mutate NOTHING. Legacy thread-less
          // interactions stay usable (migration-safe).
          if (callbackId !== undefined) {
            await deps.client.answerCallbackQuery(callbackId, {
              text: crossActionText(
                deps.interactions.resolveOwnerLabelSync(
                  targetChatId,
                  interaction.ownerTelegramUserId,
                  interaction.ownerName,
                ),
              ),
            });
          }
          auditInteraction('interaction.blocked_cross_thread', interaction, {
            requestedAction: action,
            threadId: targetThreadId,
            expectedThreadId: interaction.messageThreadId,
          });
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
      if (action === 'credentials') {
        await runCredentialsFlow(undefined);
        return { ok: true };
      }
      if (action === 'buscar') {
        await respond(SECTION_TEXTS['buscar'] ?? '🔎 BUSCAR', 'buscar');
        return { ok: true };
      }
      if (action === 'operar') {
        await openOperateDraft();
        return { ok: true };
      }
      if (action === 'vencidos') {
        await showExpired();
        return { ok: true };
      }
      if (action === 'inventario') {
        await showInventory();
        return { ok: true };
      }
      if (action === 'caja') {
        await showCash();
        return { ok: true };
      }
      if (action === 'mas') {
        await showMore();
        return { ok: true };
      }
      if (action === 'confirm') {
        const result = await confirmWithActivity();
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
      const sectionText = SECTION_TEXTS[action] ?? SECTION_TEXTS['mas'] ?? '⋯ MÁS';
      await respond(sectionText, action);
      return { ok: true };
    }

    if (decision.layer === 'L2') {
      const parse = decision.parse;
      if (parse.kind === 'credentials') {
        // Explicit datos request (L2, zero Gemini): the SAME
        // SHOW_CREDENTIALS tool the 🔐Datos button runs — button≡NL by
        // construction. Read-only: no confirmation, no draft.
        await runCredentialsFlow(undefined, parse.service);
        return { ok: true };
      }
      if (parse.kind === 'command') {
        if (parse.command === 'confirmar') {
          const result = await confirmWithActivity();
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
        await respond(placeholders[parse.command] ?? '⋯ MÁS', 'mas');
        return { ok: true };
      }
      if (
        parse.kind === 'phone' ||
        parse.kind === 'email' ||
        parse.kind === 'account'
      ) {
        // Per-requester search interaction: result buttons reject the peer;
        // the peer starts their own search. Both coexist.
        // Phone identifiers travel the customer seam; the neutral
        // ACCOUNT_IDENTIFIER (email/username/code) travels the account
        // seam — the returned servicio comes from the data row, never
        // assumed. L2 carries the identifier, so missingFields is empty
        // and the read executes immediately (no confirmation, no
        // follow-up). Phone identifiers travel `+`-preserving (`raw`)
        // so explicit +CC keeps absolute priority in the domain layer.
        await runDirectSearch(parse.kind === 'phone' ? parse.raw : parse.value);
        return { ok: true };
      }
      if (parse.kind === 'service') {
        // Bare service words keep the legacy service-row browse (zero
        // Gemini) — they are a service listing, not an account
        // identifier, so they never enter the account card flow.
        await runDirectSearch(parse.value, true);
        return { ok: true };
      }
      if (parse.kind === 'section') {
        // Home-section NL twin (L2, zero Gemini): the SAME shared
        // handler the button tap runs — button≡NL by construction.
        if (parse.section === 'buscar') {
          await showSearchPrompt();
          return { ok: true };
        }
        if (parse.section === 'operar') {
          await openOperateDraft();
          return { ok: true };
        }
        if (parse.section === 'vencidos') {
          await showExpired();
          return { ok: true };
        }
        if (parse.section === 'inventario') {
          await showInventory();
          return { ok: true };
        }
        if (parse.section === 'caja') {
          await showCash();
          return { ok: true };
        }
        await showMore();
        return { ok: true };
      }
      if (parse.kind === 'createTest') {
        // Confirm/Correct/Cancel — never executes directly.
        const resumed = deps.drafts.isOpen(owner);
        const draft = deps.drafts.create(owner, {
          months: parse.months,
          ...(targetActorName !== undefined ? { ownerName: targetActorName } : {}),
        });
        persistAll();
        auditDraft('draft.created', { months: draft.months, resumed });
        await respondDraft(renderDraftCreated(draft.months));
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
        await respondDraft(renderDraftUpdated(updated.months));
        return { ok: true };
      }
      await respond(UNKNOWN_TEXT);
      return { ok: true };
    }

    // L3 — Gemini intent only; execution stays deterministic. The model
    // receives ONLY this actor's identity — never group mutable session.
    // Ask-only-what-is-missing: the intent params are compared against
    // each tool's required fields (resolveMissingFields). Complete reads
    // execute immediately; complete writes build a draft for
    // confirmation; anything missing asks ONLY for it.
    const intent = decision.intent;
    if (intent.name === 'OPEN_CREDENTIALS') {
      // Gemini semantic/reference variant (L3): the model interpreted
      // intent+reference FIRST — this deterministic fetch runs AFTER and
      // secrets never reach the model. Same SHOW_CREDENTIALS tool as L1/L2.
      const rawService = intent.params['service'];
      const serviceFilter =
        rawService === 'netflix' || rawService === 'flujotv'
          ? (rawService as MockService)
          : undefined;
      await runCredentialsFlow(undefined, serviceFilter);
      return { ok: true };
    }
    if (intent.name === 'OPEN_SEARCH') {
      let identifier = pickSearchIdentifier(intent.params);
      if (identifier === undefined && intent.params['reference'] === 'last') {
        identifier = resolveOwnSearchQuery();
      }
      const missing = resolveMissingFields(
        'searchAccount',
        identifier === undefined ? {} : { identifier },
      );
      if (missing.length === 0 && identifier !== undefined) {
        await runDirectSearch(identifier);
        return { ok: true };
      }
      if (/cuenta/i.test(text)) {
        // Account-flavored ask: ONLY the identifier, never a service
        // question (the repo discovers the service from the row).
        const interaction = createInteraction('SEARCH', { view: 'prompt' });
        persistAll();
        await sendLabeled(
          ASK_ACCOUNT_TEXT,
          sectionKeyboard('buscar', interaction.id),
          interaction.messageThreadId,
        );
        return { ok: true };
      }
      await respond(SECTION_TEXTS['buscar'] ?? '🔎 BUSCAR', 'buscar');
      return { ok: true };
    }
    if (intent.name === 'CREATE_TEST_DRAFT') {
      // Fail-closed WRITE gate (dispatch-level enforcement): Gemini may
      // overgeneralize a bare "prueba"/"demo"/"test" or a consult phrase
      // ("revisa X") into CREATE_TEST_DRAFT. A draft is built ONLY when
      // the RAW text carries an unequivocal creation expression — never
      // on intent name alone, never with invented months. Without it the
      // request degrades to READ (identifier stated → deterministic
      // search) or UNKNOWN (clarification). WRITE ambiguity never mutates.
      if (!isExplicitCreateRequest(text)) {
        const fallbackIdentifier =
          pickSearchIdentifier(intent.params) ?? extractEmbeddedAccount(text)?.value;
        if (fallbackIdentifier !== undefined) {
          await runDirectSearch(fallbackIdentifier);
          return { ok: true };
        }
        await respond(UNKNOWN_TEXT);
        return { ok: true };
      }
      const months =
        typeof intent.params['months'] === 'number' ? intent.params['months'] : undefined;
      const missing = resolveMissingFields(
        'demoCreateTest',
        months === undefined ? {} : { months },
      );
      if (missing.length === 0 && months !== undefined) {
        // Complete mutation: draft + summary + Confirm/Correct/Cancel.
        const resumed = deps.drafts.isOpen(owner);
        const draft = deps.drafts.create(owner, {
          months,
          ...(targetActorName !== undefined ? { ownerName: targetActorName } : {}),
        });
        persistAll();
        auditDraft('draft.created', { months: draft.months, resumed });
        await respondDraft(renderDraftCreated(draft.months));
        return { ok: true };
      }
      // Incomplete mutation: same shell + same text as the Operar
      // button — it asks only for the missing correction (months).
      const resumed = deps.drafts.isOpen(owner);
      const draft = deps.drafts.create(owner, {
        ...(targetActorName !== undefined ? { ownerName: targetActorName } : {}),
      });
      persistAll();
      auditDraft('draft.created', { months: draft.months, resumed });
      await respondDraft(
        resumed ? renderDraftResumed(draft.months) : renderDraftOpened(),
      );
      return { ok: true };
    }
    if (intent.name === 'OPEN_OPERATE') {
      // Generic operate NL (no months): the SAME draft shell the OPERAR
      // button opens — button≡NL by construction, no redundant question.
      await openOperateDraft();
      return { ok: true };
    }
    if (intent.name === 'OPEN_EXPIRED') {
      await showExpired();
      return { ok: true };
    }
    if (intent.name === 'OPEN_INVENTORY') {
      await showInventory();
      return { ok: true };
    }
    if (intent.name === 'OPEN_CASH') {
      await showCash();
      return { ok: true };
    }
    if (intent.name === 'OPEN_MORE') {
      await showMore();
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
      await respondDraft(renderDraftUpdated(updated.months));
      return { ok: true };
    }
    await respond(UNKNOWN_TEXT);
    return { ok: true };
  };
}

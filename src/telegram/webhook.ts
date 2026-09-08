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
  deriveExpiryStatus,
  formatCustomerCard,
  type Customer,
} from '../mock/customers';
import { deriveNetflixProfilePin, resolveNetflixPin } from '../mock/netflixPin';
import {
  InteractionStore,
  type Interaction,
  type InteractionType,
} from '../interactions/interactions';
import type { MockRepositories, SafeAccount } from '../mock/repositories';
import type { CredentialBundle } from '../mock/credentials';
import type { MockService } from '../mock/excelLoader';
import { credentialAssignmentKey, credentialOptionLabels, resolveCredentialView } from '../tools/credentials';
import type { SaleWebhookDeps } from './saleHandlers';
import {
  SALE_ENTRY_TEXT,
  isFreshSaleCue,
  isSaleCue,
  isSaleTerminalResult,
  keyboardForSaleResult,
  renderSalePendingManagement,
  saleTextContinues,
  saleViewForResult,
} from './saleHandlers';
import { saleEntryKeyboard } from './keyboards';
import {
  expectedSaleField,
  expectedSaleFields,
  isSubstantiveSaleDraft,
  prepareNewSaleChoice,
  prepareNewSaleFromAction,
  prepareNewSaleFromText,
  refreshCurrentSale,
  RENEWAL_HOLD_TEXT,
  type SaleDeps,
  type SaleResult,
} from '../sale/newSaleTool';
import { SaleMetrics } from '../sale/saleMetrics';
import { resolveCashHolders, matchCashHolder } from '../sale/payments';
import { isRenewalText, parseSaleExtraction, extractCustomerLocation } from '../sale/saleParser';
import {
  buildWhatsAppUrl,
  resolveWhatsAppTarget,
  WHATSAPP_ASK_PHONE_TEXT,
  WHATSAPP_NO_NUMBER_TEXT,
  WHATSAPP_PREPARED_TEXT,
} from '../whatsapp/link';
import { renderCredentialWhatsAppText } from '../whatsapp/templates';
import { containsPhoneCandidate, extractEmbeddedAccount, isExplicitCreateRequest, normalizeText, parseEmail, parsePhone } from '../parser/fast';
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
  credentialCardKeyboard,
  credentialDisambiguationKeyboard,
  draftKeyboard,
  homeKeyboard,
  phoneSearchKeyboard,
  searchResultsKeyboard,
  sectionKeyboard,
  withOperator,
  type CallbackAction,
  type InlineKeyboardMarkup,
} from './keyboards';
import type { TelegramClient, TelegramContext } from './client';
import { splitTelegramText } from './lengthGuard';
import {
  esc,
  expiredRow,
  renderAccountChoices,
  renderAccountNotFound,
  renderActivitySummary,
  renderCredentialAssignmentList,
  renderCredentialCard,
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
  renderRecoverableSaleError,
  SALE_CONFIRMING_TEXT,
  SALE_TERMINAL_STALE_TEXT,
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
  /** File path for best-effort NewSale draft persistence; undefined disables it. */
  saleDraftsStatePath?: string;
  /**
   * Slice B NewSale wiring (opt-in): per-operator sale drafts + the live
   * MOCK store (inventory rows + atomic sale ledger seam). Absent =
   * legacy behavior unchanged (generic demo drafts, sale NL stays
   * guarded). Present = OPERAR opens the Venta Nueva entry, sale NL
   * converges on the same draft core as the buttons, and Confirm
   * executes the atomic service. Every sale callback travels owned, so
   * topics/ownership apply unchanged.
   */
  sale?: SaleWebhookDeps;
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
  /**
   * HOTFIX 2 transversal infra (handler scope — shared across updates):
   * - `saleMetrics`: safe UX counters per operationId (sends/edits/
   *   callbacks/turns/backs/corrections/retries/recoveries/
   *   parse-vs-Gemini/outcome/duration — never raw text, phones,
   *   wa.me URLs, or secrets). Shared with the tool layer via
   *   `SaleDeps.metrics`.
   * - `actorSaleQueue`: per-actor update serialization (no global
   *   lock): same chat+thread+actor sale updates never concurrently
   *   mutate one draft; different actors stay concurrent.
   * - `confirmInFlight`: UX-level confirm double-tap prevention
   *   (idempotency lives underneath in the atomic service).
   */
  const saleMetrics = new SaleMetrics();
  const actorSaleQueue = new Map<string, Promise<void>>();
  const confirmInFlight = new Set<string>();
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

    /**
     * Per-update sale key (chat+thread+actor): serializes one actor's
     * sale updates; different actors stay concurrent.
     */
    function actorSaleKey(): string {
      return `${targetChatId}:${targetThreadId ?? 0}:${targetActorId}`;
    }

    function enqueueActorSale<T>(run: () => Promise<T>): Promise<T> {
      const key = actorSaleKey();
      const prev = actorSaleQueue.get(key) ?? Promise.resolve();
      const next = prev.then(run, run);
      actorSaleQueue.set(
        key,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      return next;
    }

    /**
     * Slice B sale deps (additive): the SAME draft core serves button
     * taps and sale NL (button≡NL). Undefined = legacy behavior
     * (generic demo drafts only) — every existing test runs this way.
     */
    const saleToolDeps: SaleDeps | undefined =
      deps.sale === undefined
        ? undefined
        : {
            store: deps.sale.saleDrafts,
            findCustomersByPhone: (raw: string) =>
              deps.repos.searchCustomersByPhone(raw),
            inventoryRows: deps.sale.mockStore.accounts,
            metrics: saleMetrics,
            ...(deps.sale.statusOf !== undefined ? { statusOf: deps.sale.statusOf } : {}),
            ...(deps.sale.capacityOverrides !== undefined
              ? { capacityOverrides: deps.sale.capacityOverrides }
              : {}),
            cashHolders: deps.sale.cashHolders ?? resolveCashHolders(),
            saleExec: {
              mockStore: deps.sale.mockStore,
              ...(deps.sale.clock !== undefined ? { clock: deps.sale.clock } : {}),
              ...(deps.sale.statusOf !== undefined ? { statusOf: deps.sale.statusOf } : {}),
              ...(deps.sale.capacityOverrides !== undefined
                ? { capacityOverrides: deps.sale.capacityOverrides }
                : {}),
              onAlert: (alert: { title: string; summary: string }) => {
                if (deps.sale?.onAlert !== undefined) {
                  deps.sale.onAlert(alert);
                  return;
                }
                // Technical-failure alerts only (safe summary, no
                // secrets): fire-and-forget into the alerts topic when
                // configured, else log. Success never alerts.
                if (deps.alertsTopicId !== undefined) {
                  const alerts = new AlertService(deps.client);
                  void alerts
                    .sendCriticalAlert(
                      { chatId: targetChatId, alertsThreadId: deps.alertsTopicId },
                      {
                        type: 'sale-failure',
                        title: alert.title,
                        summary: alert.summary,
                        actorName: targetActorName,
                        timestamp: new Date().toISOString(),
                      },
                    )
                    .catch((error) => {
                      logger.warn({ error }, 'Sale failure alert failed');
                    });
                } else {
                  logger.warn(
                    { chatId: targetChatId, title: alert.title },
                    'Sale failure (alerts topic not configured)',
                  );
                }
              },
            },
          };

    function saleActor(): { chatId: number; userId: number; name: string } {
      return {
        chatId: targetChatId,
        userId: targetActorId,
        name: targetActorName ?? '',
      };
    }

    /** True when this actor owns an open OR already-confirmed sale draft. */
    function hasSaleDraft(): boolean {
      if (deps.sale === undefined) {
        return false;
      }
      return (
        deps.sale.saleDrafts.get(owner) !== undefined ||
        deps.sale.saleDrafts.confirmed(owner) !== undefined
      );
    }

    function hasOpenSaleDraft(): boolean {
      return deps.sale !== undefined && deps.sale.saleDrafts.get(owner) !== undefined;
    }

    /**
     * Secret-free sale audit (operationId + safe refs only — never
     * phones, names, passwords, PINs, or tokens).
     */
    function auditSaleResult(result: SaleResult): void {
      const draft = result.draft;
      auditor.record({
        chatId: targetChatId,
        actorTelegramUserId: targetActorId,
        ...(targetActorName !== undefined ? { actorName: targetActorName } : {}),
        actionType: `sale.${result.kind}`,
        entity: `sale-draft:${targetChatId}:${targetActorId}`,
        ...(draft === null
          ? {}
          : {
              metadata: {
                operationId: draft.operationId,
                version: draft.version,
                ...(draft.service !== null ? { service: draft.service } : {}),
                ...(draft.modality !== null ? { modality: draft.modality } : {}),
                ...(draft.duration.requestedMonths !== null
                  ? { months: draft.duration.requestedMonths }
                  : {}),
                ...(draft.payment.method !== null ? { method: draft.payment.method } : {}),
                ...(draft.payment.actualAmount !== null
                  ? { amount: draft.payment.actualAmount }
                  : {}),
                ...(draft.payment.currency !== null ? { currency: draft.payment.currency } : {}),
                ...(draft.payment.receivedBy !== null
                  ? { receivedBy: draft.payment.receivedBy }
                  : {}),
              },
            }),
      });
    }

    /**
     * ONE FOREGROUND INTERACTION — single-card conservation: every sale
     * continuation edits the SAME card (the stored `cardMessageId` on the
     * active OPERATION interaction). 1 initial send + N edits; confirmed/
     * cancelled transforms the same card. Callback-derived renders edit
     * the tapped message AND adopt it as the card. When no card is stored
     * yet, the first send captures its `message_id` for all later edits.
     */
    function cardMessageIdOf(interaction: Interaction): number | undefined {
      const fresh = deps.interactions.get(interaction.id) ?? interaction;
      const stored = fresh.state['cardMessageId'];
      return typeof stored === 'number' ? stored : undefined;
    }

    function extractSentMessageId(response: unknown): number | undefined {
      if (typeof response !== 'object' || response === null) {
        return undefined;
      }
      const direct = (response as { message_id?: unknown }).message_id;
      if (typeof direct === 'number') {
        return direct;
      }
      const nested = (response as { result?: unknown }).result;
      if (typeof nested === 'object' && nested !== null) {
        const nestedId = (nested as { message_id?: unknown }).message_id;
        if (typeof nestedId === 'number') {
          return nestedId;
        }
      }
      return undefined;
    }

    /**
     * Per-interaction navigation stack (presentation/navigation only).
     *
     * Each SEARCH interaction owns an ordered history of semantic views:
     * HOME (explicit root only) · SEARCH_INPUT (`prompt`) · SEARCH_RESULTS
     * (`list`/`customer-list`/`account-list`) · CUSTOMER_CARD
     * (`customer-detail`) · ACCOUNT_CARD (`account-detail`/`detail`) ·
     * ASSIGNMENT_SELECTOR (`credentials-list`/`whatsapp-list`) ·
     * CREDENTIAL_CARD (`credentials-detail`/`whatsapp-detail`) ·
     * PHONE_SELECTOR (`whatsapp-phones`).
     *
     * Sale OPERATION interactions share the SAME stack semantics:
     * `sale-entry` (the OPERAR card — Volver parent of every sale;
     * text-started sales seed it without showing it, mirroring the
     * search `prompt` seed) · `sale-batch` (ask-missing / new-customer /
     * disambiguate / clarification follow-ups, re-settled on Volver
     * against the intact draft) · `sale-summary` · `sale-pending` ·
     * `sale-emergency` · `sale-noinventory` · `sale-note` ·
     * `sale-confirmed` · `sale-cancelled` · `home` (explicit root only).
     *
     * Volver pops the stack and re-renders the exact previous VIEW of
     * the SAME interaction (same card edit when the tap came from a
     * callback); Home is NEVER a fallback — it only fires on the
     * explicit `home` action or from a seeded root parent. Stale
     * callbacks ack without touching the stack; per-actor isolation
     * comes free because the stack lives inside the owned interaction
     * (chat+thread+actor+interactionId).
     *
     * NAVIGATION NEVER MUTATES BUSINESS STATE: the stack, view, and
     * snap touch ONLY `interaction.state` (presentation snapshots —
     * SNAP_KEYS carry no sale-draft field, and sale views store an
     * empty snap). Sale drafts (NewSaleDraftStore) change ONLY through
     * the state machine: `prepareNewSale*` (fold), `confirmNewSale`
     * (Confirm path), `store.cancel` (Cancel path). External pending
     * drafts are never touched by navigation.
     */
    interface NavEntry {
      view: string;
      snap: Record<string, unknown>;
    }
    const NAV_KEY = 'nav';
    const NAV_LIMIT = 20;
    const SNAP_KEYS = [
      'query',
      'offset',
      'total',
      'selectedCustomer',
      'selectedAccount',
      'selectedIndex',
      'customerId',
      'accountId',
      'serviceFilter',
      'explicitIdentifier',
      'assignmentKeys',
      'selectedAssignmentKey',
      'phones',
      'optionIndex',
      'whatsapp',
    ];
    function navEntriesOf(interaction: Interaction): NavEntry[] {
      const raw = interaction.state[NAV_KEY];
      if (!Array.isArray(raw)) {
        return [];
      }
      return (raw as unknown[]).filter(
        (entry): entry is NavEntry =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { view?: unknown }).view === 'string',
      );
    }
    function snapOf(state: Record<string, unknown>): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      for (const key of SNAP_KEYS) {
        if (state[key] !== undefined) {
          out[key] = state[key];
        }
      }
      return out;
    }
    /**
     * Records a forward transition: pushes the current view (when it
     * differs) then stores the next view. Same-view re-renders never push,
     * so restores and idempotent repeats keep the stack stable.
     */
    function transitionTo(
      interaction: Interaction,
      nextView: string,
      patch: Record<string, unknown> = {},
    ): Interaction {
      const current =
        typeof interaction.state['view'] === 'string'
          ? (interaction.state['view'] as string)
          : undefined;
      const nav = navEntriesOf(interaction);
      let nextNav = nav;
      if (current !== undefined && current !== nextView) {
        nextNav = [...nav, { view: current, snap: snapOf(interaction.state) }];
        if (nextNav.length > NAV_LIMIT) {
          nextNav = nextNav.slice(nextNav.length - NAV_LIMIT);
        }
      }
      const updated = deps.interactions.touch(interaction.id, {
        ...patch,
        view: nextView,
        [NAV_KEY]: nextNav,
      });
      return updated ?? interaction;
    }
    /** Seeds the SEARCH_INPUT parent on a freshly created interaction. */
    function seedNavParent(interaction: Interaction): Interaction {
      const nav = navEntriesOf(interaction);
      if (nav.length > 0) {
        return interaction;
      }
      const updated = deps.interactions.touch(interaction.id, {
        [NAV_KEY]: [{ view: 'prompt', snap: {} }],
      });
      return updated ?? interaction;
    }
    /**
     * Seeds the sale Volver parent on a freshly created OPERATION
     * interaction (default `sale-entry`, `home` for the OPERAR card
     * itself). Text-started and callback-started sales share this, so
     * both get identical NavStack semantics. No-op on interactions
     * that already carry a view or a stack.
     */
    function seedSaleNavParent(interaction: Interaction, parentView: string): Interaction {
      const fresh = deps.interactions.get(interaction.id) ?? interaction;
      if (
        navEntriesOf(fresh).length > 0 ||
        typeof fresh.state['view'] === 'string'
      ) {
        return fresh;
      }
      const updated = deps.interactions.touch(fresh.id, {
        [NAV_KEY]: [{ view: parentView, snap: {} }],
      });
      return updated ?? fresh;
    }

    /**
     * Card-lost classifier: the message was deleted / not found (recover
     * by rendering current state into a NEW replacement card — the draft
     * is the source of truth, never the message). `message is not
     * modified` is NOT lost (same content — success, no resend, no
     * duplicate card).
     */
    function isCardLostError(error: unknown): boolean {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : JSON.stringify(error ?? '');
      if (/message is not modified/i.test(message)) {
        return false;
      }
      return /not found|to edit not found|can't be edited|cannot be edited|deleted|message_id_invalid|MESSAGE_ID_INVALID|message to edit/i.test(
        message,
      );
    }

    /** Idempotent re-render of identical content: success, never a duplicate card. */
    function isNotModifiedError(error: unknown): boolean {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : JSON.stringify(error ?? '');
      return /message is not modified/i.test(message);
    }

    function operationIdOf(interaction: Interaction): string | undefined {
      const stored = (deps.interactions.get(interaction.id) ?? interaction).state['operationId'];
      return typeof stored === 'string' ? stored : undefined;
    }

    /**
     * Deactivates one stale card's keyboard in place (text untouched).
     * Best-effort: card-lost and missing-method cases resolve to silence
     * (the card is already harmless or the stub cannot edit markup).
     */
    function deactivateCardButtons(messageId: number): void {
      const edit = deps.client.editMessageReplyMarkup;
      if (edit === undefined) {
        return;
      }
      void edit
        .call(deps.client, {
          chatId: targetChatId,
          messageId,
          replyMarkup: { inline_keyboard: [] },
        })
        .catch(() => undefined);
    }

    /**
     * Single-ACTIVE-card enforcement: when a new foreground card
     * activates, the prior Home/operational cards of the same actor in
     * the same thread lose their keyboards (old buttons are not
     * tappable). Terminal cards are already frozen (zero callbacks), so
     * they need no deactivation. Fire-and-forget: no latency added to
     * the ack/edit path.
     *
     * The legacy path (search/Home/expired/inventory/cash/more) passes
     * its own interaction: OPERATION/HOME keep the core behavior above;
     * any other type additionally deactivates PENDING siblings of that
     * SAME type only (an old search list dies when a new search lands —
     * an open sale draft's keyboard is never touched from a search).
     */
    function deactivateStaleForegroundCards(
      exceptInteractionId: string,
      sameType?: InteractionType,
    ): void {
      const coreOnly =
        sameType === undefined || sameType === 'OPERATION' || sameType === 'HOME';
      for (const candidate of deps.interactions.snapshot()) {
        if (candidate.id === exceptInteractionId) {
          continue;
        }
        if (
          candidate.chatId !== targetChatId ||
          candidate.ownerTelegramUserId !== targetActorId ||
          candidate.status !== 'PENDING'
        ) {
          continue;
        }
        if (coreOnly) {
          if (candidate.type !== 'OPERATION' && candidate.type !== 'HOME') {
            continue;
          }
        } else if (candidate.type !== sameType) {
          continue;
        }
        if (
          targetThreadId !== undefined &&
          candidate.messageThreadId !== undefined &&
          candidate.messageThreadId !== targetThreadId
        ) {
          continue;
        }
        const stored = candidate.state['cardMessageId'];
        if (typeof stored !== 'number') {
          continue;
        }
        deactivateCardButtons(stored);
      }
    }

    async function sendSaleCard(
      interaction: Interaction,
      resultText: string,
      replyMarkup: InlineKeyboardMarkup,
      threadOverride?: number,
    ): Promise<void> {
      await ackOwnedReceipt();
      // Central pre-send length guard (same as the legacy path):
      // the first part keeps the edit/replacement path + keyboard,
      // the remainder travels as same-thread follow-ups.
      const saleParts = splitTelegramText(resultText).map((part) =>
        withOperator(part, targetActorName),
      );
      const labeled = saleParts[0] ?? withOperator(resultText, targetActorName);
      const saleFollowUps = saleParts.slice(1);
      const sendSaleFollowUps = async (): Promise<void> => {
        const thread = threadOverride ?? replyCtx.messageThreadId;
        for (const extra of saleFollowUps) {
          await deps.client.sendMessage({
            chatId: targetChatId,
            text: extra,
            ...(thread !== undefined ? { messageThreadId: thread } : {}),
          });
        }
      };
      const operationId = operationIdOf(interaction);
      const track = (event: 'send' | 'edit' | 'resend' | 'recovery'): void => {
        if (operationId !== undefined) {
          saleMetrics.record(operationId, event);
          if (event === 'resend') {
            saleMetrics.record(operationId, 'recovery');
          }
        }
      };
      /** Card-lost recovery: render current state into a NEW card, adopt it, continue. */
      const resendFresh = async (): Promise<void> => {
        const thread = threadOverride ?? replyCtx.messageThreadId;
        const response = await deps.client.sendMessage({
          chatId: targetChatId,
          text: labeled,
          replyMarkup,
          ...(thread !== undefined ? { messageThreadId: thread } : {}),
        });
        const sentId = extractSentMessageId(response);
        if (sentId !== undefined) {
          deps.interactions.touch(interaction.id, { cardMessageId: sentId });
          persistAll();
        }
        track('resend');
      };
      if (fromCallback && callbackMessageId !== undefined) {
        try {
          await deps.client.editMessageText({
            chatId: targetChatId,
            messageId: callbackMessageId,
            text: labeled,
            replyMarkup,
          });
          track('edit');
          deps.interactions.touch(interaction.id, { cardMessageId: callbackMessageId });
          persistAll();
        } catch (error) {
          if (isNotModifiedError(error)) {
            track('edit');
            deps.interactions.touch(interaction.id, { cardMessageId: callbackMessageId });
            persistAll();
          } else {
            if (!isCardLostError(error)) {
              throw error;
            }
            // Tapped message is gone: the replacement card (adopted inside
            // resendFresh) becomes the foreground card — never re-adopt
            // the dead id.
            await resendFresh();
          }
        }
      } else {
        const cardId = cardMessageIdOf(interaction);
        if (cardId !== undefined) {
          try {
            await deps.client.editMessageText({
              chatId: targetChatId,
              messageId: cardId,
              text: labeled,
              replyMarkup,
            });
            track('edit');
          } catch (error) {
            if (isNotModifiedError(error)) {
              track('edit');
            } else {
              if (!isCardLostError(error)) {
                throw error;
              }
              await resendFresh();
            }
          }
        } else {
          const thread = threadOverride ?? replyCtx.messageThreadId;
          const response = await deps.client.sendMessage({
            chatId: targetChatId,
            text: labeled,
            replyMarkup,
            ...(thread !== undefined ? { messageThreadId: thread } : {}),
          });
          const sentId = extractSentMessageId(response);
          if (sentId !== undefined) {
            deps.interactions.touch(interaction.id, { cardMessageId: sentId });
            persistAll();
          }
          track('send');
        }
      }
      await sendSaleFollowUps();
      await ackOwnedReceipt();
    }

    /**
     * Sale single-card render with NavStack recording (shared by
     * text-start and callback-start — identical semantics): seeds the
     * Volver parent on fresh OPERATION interactions, sends/edits the
     * ONE card, then records the rendered sale view so Volver pops to
     * the exact producing view. Confirm kinds also close the
     * interaction. Previous-context policy: the sale draft NEVER reads
     * search queries, selections, or finished-interaction context — the
     * ONLY phone/customer source is the current turn's explicit
     * identifier folded by `prepareNewSale*` (explicit > nothing;
     * stored context never fills critical fields across operations).
     */
    /**
     * Fresh Home AFTER terminal (HOTFIX 2): a NEW Home card is sent
     * BELOW the frozen terminal card — own actor topic only (never
     * General/Alertas: the origin interaction's thread wins), with its
     * own messageId on its own HOME interaction + NavStack. It becomes
     * the foreground root: new operations use/adopt it, never the
     * terminal card.
     */
    async function sendFreshHomeBelow(origin: Interaction): Promise<void> {
      const home = createInteraction('HOME');
      const thread = origin.messageThreadId ?? replyCtx.messageThreadId;
      const response = await deps.client.sendMessage({
        chatId: targetChatId,
        text: withOperator(HOME_TEXT, targetActorName),
        replyMarkup: homeKeyboard(home.id),
        ...(thread !== undefined ? { messageThreadId: thread } : {}),
      });
      const sentId = extractSentMessageId(response);
      if (sentId !== undefined) {
        deps.interactions.touch(home.id, { cardMessageId: sentId });
      }
      persistAll();
      auditInteraction('interaction.home_after_terminal', home, {
        ...(typeof origin.state['operationId'] === 'string'
          ? { terminalOperationId: origin.state['operationId'] }
          : {}),
      });
    }

    async function sendSaleResult(
      interaction: Interaction,
      result: SaleResult,
      threadOverride?: number,
      keyboardOverride?: InlineKeyboardMarkup,
    ): Promise<void> {
      const seeded = seedSaleNavParent(interaction, 'sale-entry');
      const navigated = transitionTo(seeded, saleViewForResult(result));
      // Operation/version gate for stale-callback validation (safe
      // refs only — never phones, names, or secrets).
      if (result.draft !== null) {
        deps.interactions.touch(navigated.id, {
          operationId: result.draft.operationId,
          operationVersion: result.draft.version,
        });
      }
      persistAll();
      if (isSaleTerminalResult(result)) {
        // Terminal states freeze: the card renders its final result
        // (CONFIRMED keeps the WhatsApp URL; CANCELLED is compact) with
        // a zero-callback frozen keyboard, then the interaction closes.
        // Frozen cards are never edited again by any future operation.
        await sendSaleCard(
          navigated,
          result.text,
          keyboardOverride ?? keyboardForSaleResult(result, navigated.id, result.whatsappUrl),
          threadOverride ?? navigated.messageThreadId,
        );
        if (result.kind === 'cancelled') {
          // The draft is already dropped (nothing persists) — outcome
          // attribution happened at the cancel entry; closing the card
          // here only freezes it.
          deps.interactions.cancel(navigated.id);
        } else {
          deps.interactions.confirm(navigated.id);
          if (result.draft !== null) {
            saleMetrics.finish(result.draft.operationId, 'confirmed');
          }
        }
        persistAll();
        await sendFreshHomeBelow(navigated);
        return;
      }
      // New foreground card: deactivate stale keyboards of the prior
      // Home/operational cards so old buttons are not tappable.
      deactivateStaleForegroundCards(navigated.id);
      await sendSaleCard(
        navigated,
        result.text,
        keyboardOverride ?? keyboardForSaleResult(result, navigated.id, result.whatsappUrl),
        threadOverride ?? navigated.messageThreadId,
      );
    }

    /**
     * Recoverable failure card (HOTFIX 2, Part C): human language, no
     * codes/stacks (technical detail stays in logs). The draft is kept;
     * [Reintentar → saleKeep][←Volver][❌Cancelar] preserve continuation
     * (recognition > memory, progressive disclosure, no dead ends).
     */
    async function sendSaleRecoverable(
      origin: Interaction | undefined,
      threadOverride?: number,
    ): Promise<void> {
      if (saleToolDeps === undefined) {
        return;
      }
      const open = saleToolDeps.store.get(owner) ?? null;
      if (open !== null) {
        saleMetrics.record(open.operationId, 'retry');
      }
      const interaction =
        origin ?? activeOperationInteraction() ?? createInteraction('OPERATION');
      const result: SaleResult = {
        kind: 'clarification',
        draft: open,
        text: renderRecoverableSaleError(),
        retryable: true,
      };
      auditSaleResult(result);
      await sendSaleResult(
        interaction,
        result,
        threadOverride ?? interaction.messageThreadId,
      );
    }

    /**
     * Sale NL entry: folds one operator sentence into the actor's sale
     * draft (full-sentence → single summary + Confirm; partial →
     * ask-only-missing; corrections recalc the SAME draft). Single-card:
     * every continuation edits the stored card. Serialized per actor (no
     * global lock); technical failures keep the draft and answer the
     * recoverable card (never codes/stacks in UX).
     */
    async function runSaleText(input: string, threadOverride?: number): Promise<void> {
      if (saleToolDeps === undefined) {
        return;
      }
      return enqueueActorSale(async () => {
        if (saleToolDeps === undefined) {
          return;
        }
        try {
          const result = await prepareNewSaleFromText(saleActor(), input, saleToolDeps);
          auditSaleResult(result);
          const interaction = activeOperationInteraction() ?? createInteraction('OPERATION');
          await sendSaleResult(
            interaction,
            result,
            threadOverride ?? interaction.messageThreadId,
          );
        } catch (error) {
          logger.warn({ error }, 'Sale text flow failed');
          await sendSaleRecoverable(undefined, threadOverride);
        }
      });
    }

    /**
     * Sale Confirm entry (button tap or NL `confirmar`): executes the
     * atomic service when a sale draft is open, answers `already
     * confirmed` on repeats (zero new rows). Confirm transforms the SAME
     * card in place, then freezes it + sends the fresh Home below.
     * UX-level double-tap prevention: the transient `⏳ Confirmando…`
     * shows ONLY when the op takes perceptibly long (never a flicker on
     * instant ops); concurrent taps for the same actor collapse into one
     * execution (idempotency underneath is untouched).
     */
    async function runSaleConfirmFlow(
      origin: Interaction | undefined,
      threadOverride?: number,
    ): Promise<void> {
      if (saleToolDeps === undefined) {
        return;
      }
      return enqueueActorSale(async () => {
        if (saleToolDeps === undefined) {
          return;
        }
        const key = actorSaleKey();
        if (confirmInFlight.has(key)) {
          await ackOwnedReceipt();
          return;
        }
        confirmInFlight.add(key);
        let slowTimer: ReturnType<typeof setTimeout> | undefined;
        // CONFIRMING guard: the transient `⏳ Confirmando…` is NEVER
        // terminal. `settled` flips once the confirm result is about to
        // render, so a late transient edit (which could otherwise land
        // after the real result on a slow op) becomes a no-op — the card
        // always ends on the actual confirm outcome, never on "Confirmando".
        let settled = false;
        try {
          const interaction =
            origin ?? activeOperationInteraction() ?? createInteraction('OPERATION');
          slowTimer = setTimeout(() => {
            void (async () => {
              try {
                if (settled) {
                  return;
                }
                const cardId = cardMessageIdOf(interaction);
                if (cardId !== undefined) {
                  await Promise.resolve();
                  if (settled) {
                    return;
                  }
                  await deps.client.editMessageText({
                    chatId: targetChatId,
                    messageId: cardId,
                    text: withOperator(SALE_CONFIRMING_TEXT, targetActorName),
                    replyMarkup: { inline_keyboard: [] },
                  });
                }
              } catch {
                // Best-effort transient — never breaks the confirm path.
              }
            })();
          }, 800);
          if (slowTimer.unref !== undefined) {
            slowTimer.unref();
          }
          const result = await prepareNewSaleFromAction(
            saleActor(),
            { type: 'confirm-sale' },
            saleToolDeps,
          );
          auditSaleResult(result);
          settled = true;
          await sendSaleResult(
            interaction,
            result,
            threadOverride ?? interaction.messageThreadId,
          );
        } catch (error) {
          logger.warn({ error }, 'Sale confirm flow failed');
          // Unknown-commit reconcile (idempotency by operationId): the
          // atomic commit may have succeeded even though rendering it
          // failed (e.g. the confirmed-card edit threw after the rows
          // were written). If the sale DID commit, show the committed
          // data (credentials/WhatsApp) and send the fresh Home — never
          // a misleading "draft intact" error, never a resell. Otherwise
          // the draft is intact → recoverable retry card.
          if (saleToolDeps.store.confirmed(owner) !== undefined) {
            const interaction =
              origin ?? activeOperationInteraction() ?? createInteraction('OPERATION');
            const committed = await prepareNewSaleFromAction(
              saleActor(),
              { type: 'confirm-sale' },
              saleToolDeps,
            );
            auditSaleResult(committed);
            await sendSaleResult(
              interaction,
              committed,
              threadOverride ?? interaction.messageThreadId,
            );
          } else {
            await sendSaleRecoverable(origin, threadOverride);
          }
        } finally {
          if (slowTimer !== undefined) {
            clearTimeout(slowTimer);
          }
          confirmInFlight.delete(key);
        }
      });
    }

    /**
     * Sale Cancel entry: drops the open draft, freezes the SAME card to
     * its compact result (zero callbacks), then sends the fresh Home
     * below. Serialized per actor; failures answer the recoverable card.
     */
    async function runSaleCancelFlow(
      origin: Interaction | undefined,
      threadOverride?: number,
    ): Promise<void> {
      if (saleToolDeps === undefined) {
        return;
      }
      return enqueueActorSale(async () => {
        if (saleToolDeps === undefined) {
          return;
        }
        try {
          // Outcome attribution BEFORE the drop: `cancel-sale` returns a
          // null draft (nothing persists), so the id is captured here.
          const openBefore = saleToolDeps.store.get(owner) ?? null;
          const result = await prepareNewSaleFromAction(
            saleActor(),
            { type: 'cancel-sale' },
            saleToolDeps,
          );
          auditSaleResult(result);
          if (result.kind === 'cancelled' && openBefore !== null) {
            saleMetrics.finish(openBefore.operationId, 'cancelled');
          }
          const interaction =
            origin ?? activeOperationInteraction() ?? createInteraction('OPERATION');
          await sendSaleResult(
            interaction,
            result,
            threadOverride ?? interaction.messageThreadId,
          );
        } catch (error) {
          logger.warn({ error }, 'Sale cancel flow failed');
          await sendSaleRecoverable(origin, threadOverride);
        }
      });
    }

    /** Sale emergency-auth entry: explicit, separate from confirmation. */
    async function runSaleEmergencyFlow(
      origin: Interaction,
      threadOverride?: number,
    ): Promise<void> {
      if (saleToolDeps === undefined) {
        return;
      }
      const result = await prepareNewSaleFromAction(
        saleActor(),
        { type: 'authorize-emergency' },
        saleToolDeps,
      );
      auditSaleResult(result);
      persistAll();
      await sendSaleResult(
        origin,
        result,
        threadOverride ?? origin.messageThreadId,
      );
    }

    /**
     * Sale choice entry (service/modality option buttons): folds the
     * structured choice into the SAME open draft, single-card render.
     */
    async function runSaleChoiceFlow(
      origin: Interaction,
      choice: { service: 'netflix' | 'flujotv'; modality: 'netflix-profile' | 'flujotv-shared' | 'flujotv-complete' },
      threadOverride?: number,
    ): Promise<void> {
      if (saleToolDeps === undefined) {
        return;
      }
      const result = await prepareNewSaleChoice(saleActor(), choice, saleToolDeps);
      auditSaleResult(result);
      persistAll();
      await sendSaleResult(
        origin,
        result,
        threadOverride ?? origin.messageThreadId,
      );
    }

    /**
     * [Continuar venta] / NL `continuar`: re-renders the in-progress
     * draft on the SAME card (re-settle, zero patch, zero mutation).
     */
    async function runSaleResumeFlow(
      origin: Interaction,
      threadOverride?: number,
    ): Promise<void> {
      if (saleToolDeps === undefined) {
        return;
      }
      const result = await refreshCurrentSale(saleActor(), saleToolDeps);
      auditSaleResult(result);
      persistAll();
      await sendSaleResult(
        origin,
        result,
        threadOverride ?? origin.messageThreadId,
      );
    }

    /**
     * Second-operation guard: an unrelated fresh sale cue while a
     * substantive draft is open edits the SAME card to GESTIÓN PENDIENTE
     * with [Continuar venta][Cancelar venta] — never a parallel card,
     * never a draft touch.
     */
    async function runSalePendingFlow(
      origin: Interaction,
      threadOverride?: number,
    ): Promise<void> {
      const open = saleToolDeps?.store.get(owner) ?? null;
      const result: SaleResult = {
        kind: 'pending',
        draft: open,
        text: renderSalePendingManagement(),
      };
      await sendSaleResult(
        origin,
        result,
        threadOverride ?? origin.messageThreadId,
      );
    }

    /**
     * ACTIVE-INTERACTION-FIRST text handling (mandatory router order):
     * while the actor owns an open sale draft, the draft owns EVERY text
     * message — the global fast-parser/deterministic intents and Gemini
     * NEVER see it. Order inside the operation:
     * (0) renewal words → safe hold on the same card (reserved, never
     *     folded into NEW_SALE);
     * (1) standalone navigation (`volver`/`cancelar`/`confirmar`/
     *     `continuar` as the message command) — explicit commands win
     *     over field fill, otherwise Cancelar could never fire while a
     *     name is expected;
     * (2) fresh second sale cue on a substantive draft → GESTIÓN
     *     PENDIENTE on the same card (no parallel card, draft intact);
     * (3) any sale field / correction → fold into the SAME draft;
     * (4) expected-field fill (local parse in field scope: bare holder
     *     name → receiver; name-like text → customer name);
     * (5) uninterpretable-inside-operation → same-card fallback naming
     *     the expected field, draft intact, never a global jump, never
     *     Gemini.
     *
     * This is the "Gabriel Juan" root-cause fix: the new-customer name
     * answer used to fall through to global search (CUENTA NO ENCONTRADA
     * + a second card); now it fills `draft.proposedCustomer.name` and
     * continues to the next missing field on the same card.
     */
    async function handleActiveSaleText(input: string): Promise<boolean> {
      if (saleToolDeps === undefined) {
        return false;
      }
      const open = saleToolDeps.store.get(owner);
      if (open === undefined) {
        return false;
      }
      const interaction = activeOperationInteraction() ?? createInteraction('OPERATION');
      const trimmed = input.trim();
      const n = normalizeText(trimmed);

      // Bare-greeting short-circuit (the "hola" defect): a standalone
      // greeting while a sale is active is NEVER a field answer, a
      // command, or a fresh NEW_SALE — it is intercepted HERE, before
      // any command/name/new-sale branch, and updates the SAME card to
      // the pending-management notice (draft intact, no cancel, no Home,
      // no second card). Real customer-name answers are unaffected
      // (isGreetingText never matches them).
      if (isGreetingText(trimmed)) {
        await runSalePendingFlow(interaction, interaction.messageThreadId);
        return true;
      }

      if (isRenewalText(trimmed)) {
        const renewal: SaleResult = {
          kind: 'clarification',
          draft: open,
          text: RENEWAL_HOLD_TEXT,
        };
        await sendSaleResult(
          interaction,
          renewal,
          interaction.messageThreadId,
        );
        return true;
      }

      if (/^(volver|atras|back)\b/.test(n)) {
        // Volver inside the sale: pop the sale NavStack to the exact
        // previous view on the SAME message, draft intact (external
        // drafts survive; phones are never swapped, nothing is
        // cancelled — navigation only touches interaction.state).
        await handleBack(interaction);
        return true;
      }
      if (/^cancel(ar|o|ado)?\b/.test(n)) {
        await runSaleCancelFlow(interaction, interaction.messageThreadId);
        return true;
      }
      if (/^confirm(ar|o|ado)?\b/.test(n)) {
        await runSaleConfirmFlow(interaction, interaction.messageThreadId);
        return true;
      }
      if (/^(continuar|continuo|continua|seguir|sigue)\b/.test(n)) {
        await runSaleResumeFlow(interaction, interaction.messageThreadId);
        return true;
      }

      const substantive = isSubstantiveSaleDraft(open);
      const extraction = parseSaleExtraction(trimmed);
      if (extraction.isCorrection) {
        saleMetrics.record(open.operationId, 'correction');
      }
      if (substantive && isFreshSaleCue(trimmed) && !extraction.isCorrection) {
        await runSalePendingFlow(interaction, interaction.messageThreadId);
        return true;
      }

      const carriesField =
        extraction.service !== undefined ||
        extraction.modality !== undefined ||
        extraction.unsupported !== undefined ||
        extraction.months !== undefined ||
        extraction.amount !== undefined ||
        extraction.method !== undefined ||
        extraction.phoneRaw !== undefined ||
        extraction.receiverRaw !== undefined ||
        extraction.referenceRaw !== undefined ||
        extraction.isCorrection ||
        extractCustomerLocation(trimmed, extraction) !== undefined;
      if (carriesField) {
        await runSaleText(trimmed, interaction.messageThreadId);
        return true;
      }

      const expected = expectedSaleField(open);
      if (expected === 'receiver') {
        const holder = matchCashHolder(trimmed, saleToolDeps.cashHolders ?? resolveCashHolders());
        if (holder !== undefined) {
          // Bare holder name inside the receiver scope ("Edward").
          await runSaleText(`lo recibió ${holder}`, interaction.messageThreadId);
          return true;
        }
      }
      if (
        expected === 'customer' &&
        open.phone !== null &&
        open.customer.existingCustomerId === undefined &&
        open.customer.proposedCustomer === undefined &&
        isNameLikeAnswer(trimmed)
      ) {
        // The "Gabriel Juan" fix: the new-customer name answer fills
        // `draft.proposedCustomer.name` (local parse first, zero Gemini)
        // and continues to the next missing field on the same card. An
        // explicit location rides along (`Gabriel Juan de Caracas` →
        // name + location); a location-ONLY turn (`vive en Valencia`)
        // folds the location via the tool and keeps asking the name —
        // location never answers the name question, never adds a turn.
        const nameExtraction = parseSaleExtraction(trimmed);
        const nameLocation = extractCustomerLocation(trimmed, nameExtraction);
        const nameText =
          nameLocation !== undefined ? trimmed.split(nameLocation.span).join(' ').trim() : trimmed;
        if (nameText === '') {
          await runSaleText(trimmed, interaction.messageThreadId);
          return true;
        }
        if (!isNameLikeAnswer(nameText)) {
          await runSaleText(trimmed, interaction.messageThreadId);
          return true;
        }
        const result = await prepareNewSaleFromAction(
          saleActor(),
          {
            type: 'provide-name',
            name: nameText,
            ...(nameLocation !== undefined
              ? {
                  location: {
                    raw: nameLocation.raw,
                    display: nameLocation.display,
                    ...(nameLocation.city !== undefined ? { city: nameLocation.city } : {}),
                    ...(nameLocation.stateRegion !== undefined
                      ? { stateRegion: nameLocation.stateRegion }
                      : {}),
                    ...(nameLocation.country !== undefined
                      ? { country: nameLocation.country }
                      : {}),
                  },
                }
              : {}),
          },
          saleToolDeps,
        );
        auditSaleResult(result);
        await sendSaleResult(
          interaction,
          result,
          interaction.messageThreadId,
        );
        return true;
      }

      // Unrelated SEARCH/READ/UNKNOWN while the sale is active: never a
      // second card, never a cancel, never silence — the SAME card shows
      // the pending-management notice (draft intact) so the operator
      // resumes or cancels. Global search/Gemini never see the message.
      await runSalePendingFlow(interaction, interaction.messageThreadId);
      return true;
    }

    /**
     * Bare-greeting classifier (active-sale UNKNOWN): a standalone
     * greeting ("hola", "buenos dias", "que tal", "saludos"…) is NOT a
     * customer name. While a sale waits for a name, a greeting must fall
     * through to the pending-management notice on the SAME card instead
     * of being folded into `proposedCustomer.name` (the "hola" defect).
     * Real name answers ("Gabriel Juan", "Ana Ruiz") are unaffected.
     */
    function isGreetingText(trimmed: string): boolean {
      const n = normalizeText(trimmed)
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (n === '') {
        return false;
      }
      const exact = new Set([
        'hola',
        'holi',
        'hello',
        'hi',
        'hey',
        'buenas',
        'buenos',
        'buen dia',
        'buenos dias',
        'buenas dias',
        'buenas tardes',
        'buenas noches',
        'que tal',
        'q tal',
        'como estas',
        'como andas',
        'como va',
        'saludos',
        'que hubo',
        'hola buenas',
      ]);
      if (exact.has(n)) {
        return true;
      }
      // Repeated-letter variants: "holaaa", "heeyy", "hii".
      return /^(h+o+l+a+|h+i+|h+e+y+|h+e+l+l+o+)$/.test(n);
    }

    /**
     * Name-like answer guard (customer-name scope only): letters/spaces
     * with no digits, not a reserved command word, not a bare greeting.
     * Runs over folded text so case/accents never matter; hostiles like
     * "cancelar" stay commands (navigation wins over fill).
     */
    function isNameLikeAnswer(trimmed: string): boolean {
      if (trimmed.length < 2 || trimmed.length > 80) {
        return false;
      }
      if (/\d/.test(trimmed)) {
        return false;
      }
      if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(trimmed)) {
        return false;
      }
      if (isGreetingText(trimmed)) {
        return false;
      }
      const n = ` ${normalizeText(trimmed)} `;
      if (
        /\b(volver|atras|back|cancel|confirm|continuar|seguir|venta|vende|vender|vendo|datos|whatsapp|inventario|caja|buscar|operar|tasa|precio|codigo|recarg|renuev|renov)\b/.test(n)
      ) {
        return false;
      }
      return true;
    }

    /** Human label for the expected field (fallback card naming). */
    function saleFieldLabel(
      draft: import('../sale/newSaleDraft').NewSaleDraft,
      fieldName: string,
    ): string {
      switch (fieldName) {
        case 'service':
          return 'el servicio';
        case 'modality':
          return 'la modalidad';
        case 'customer':
          return draft.phone === null ? 'el teléfono del cliente' : 'el nombre del cliente';
        case 'months':
          return 'la duración';
        case 'method':
          return 'el método de pago';
        case 'amount':
          return 'el monto recibido';
        case 'receiver':
          return 'quién recibió el dinero';
        default:
          return 'un dato pendiente';
      }
    }
    /**
     * Contextual UNKNOWN (never bare): keeps the stable UNKNOWN_TEXT
     * prefix and appends WHAT was expected — the open sale draft's
     * missing fields (via expected-field knowledge), a caller hint
     * naming the expected identifier or section, or the available
     * sections otherwise — so the operator always sees the next step.
     */
    function unknownHelpText(hint?: string): string {
      const lines = [UNKNOWN_TEXT];
      if (hint !== undefined && hint !== '') {
        lines.push(hint);
      } else if (saleToolDeps !== undefined) {
        const open = saleToolDeps.store.get(owner);
        if (open !== undefined) {
          const missing = expectedSaleFields(open);
          if (missing.length > 0) {
            const names = missing.map((field) => saleFieldLabel(open, field)).join(', ');
            lines.push(`🧾 Venta en curso: sigo esperando ${names}.`);
          }
        }
      }
      lines.push('Secciones: Operar, Buscar, Vencidos, Inventario, Caja, Más.');
      return lines.join('\n');
    }
    const draftEntity = `draft:${targetChatId}:${targetActorId}`;
    const fromCallback = callback !== undefined;
    const callbackId = callback?.id;
    const callbackMessageId = callback?.message?.message_id;
    /**
     * Callback ack discipline (latency root fix): ownership/auth-minimal
     * checks run first, then `ackOwnedReceipt()` fires BEFORE any state
     * recompute, render, or edit — the ack is pure receipt, never a
     * mutation promise (validate→draft→confirm→atomic still govern every
     * mutation). Idempotent: exactly one answer per callback, never a
     * double-answer. The `callback-ack` log line (ids only, zero
     * payloads) separates ack latency from recompute/edit latency, so
     * future slowness is attributable (network vs ack vs recompute vs
     * edit).
     */
    let callbackAcked = false;
    async function ackOwnedReceipt(opts?: { text?: string }): Promise<void> {
      if (callbackId === undefined || callbackAcked) {
        return;
      }
      callbackAcked = true;
      logger.info(
        { userId: actorId, chatId, updateId, stage: 'callback-ack' },
        'Answered Telegram callback',
      );
      if (opts?.text !== undefined) {
        await deps.client.answerCallbackQuery(callbackId, { text: opts.text });
      } else {
        await deps.client.answerCallbackQuery(callbackId);
      }
    }
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
    /**
     * ACTIVE-INTERACTION-FIRST (mandatory router order): while this actor
     * owns an open sale draft, the draft owns EVERY text message —
     * expected-field fill, in-operation correction/navigation, valid
     * in-operation actions, and second-mutation guarding all run BEFORE
     * the global router. The global fast-parser/deterministic intents
     * and Gemini run ONLY when no active interaction owns the message,
     * so global search can NEVER steal an expected-field answer (the
     * "Gabriel Juan" bug class). Diagnostic commands never enter here.
     */
    if (saleToolDeps !== undefined && callbackData === undefined && text.length > 0) {
      const firstToken = (text.split(/\s+/)[0] ?? '').split('@')[0]?.toLowerCase();
      if (firstToken !== '/topicid' && firstToken !== '/testalert' && firstToken !== '/start') {
        if (saleToolDeps.store.get(owner) !== undefined) {
          const owned = await handleActiveSaleText(text);
          if (owned) {
            return { ok: true };
          }
        } else if (isRenewalText(text)) {
          // Renewal with no open draft: safe hold, zero draft, zero
          // Gemini, zero ledger — reserved, never NEW_SALE.
          await sendInContext(RENEWAL_HOLD_TEXT);
          return { ok: true };
        }
      }
    }
    /**
     * Slice B sale NL interception (additive, pre-router): sale cues
     * (`quiero vender`, `venta nueva`, `vende…`, `dame/sácame/necesito…
     * cuenta/perfil…`) and continuations of an open sale draft converge
     * on the SAME draft core as the buttons with ZERO Gemini. Everything
     * else falls through to the L1/L2/L3 cascade unchanged. Diagnostic
     * commands never enter the sale flow.
     */
    if (saleToolDeps !== undefined && callbackData === undefined && text.length > 0) {
      const firstToken = (text.split(/\s+/)[0] ?? '').split('@')[0]?.toLowerCase();
      if (firstToken !== '/topicid' && firstToken !== '/testalert' && firstToken !== '/start') {
        if (isSaleCue(text) || (hasOpenSaleDraft() && saleTextContinues(text))) {
          await runSaleText(text);
          return { ok: true };
        }
      }
    }
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
      if (deps.saleDraftsStatePath !== undefined && deps.sale !== undefined) {
        deps.sale.saleDrafts.saveToFile(deps.saleDraftsStatePath).catch((error) => {
          logger.warn({ error }, 'SaleDraft persist failed');
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
        await ackOwnedReceipt({ text: crossActionText(ownerName) });
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
      await ackOwnedReceipt();
      auditor.record({
        chatId: targetChatId,
        actorTelegramUserId: targetActorId,
        ...(targetActorName !== undefined ? { actorName: targetActorName } : {}),
        actionType: 'interaction.stale_callback',
        ...(requestedAction !== undefined ? { metadata: { requestedAction } } : {}),
      });
    }

    /**
     * Labeled send-or-edit (legacy path: search/Home/expired/inventory/
     * cash/more and every other non-sale card): every interactive
     * message shows its operator. Fresh messages return to the origin
     * topic through the centralized context; `threadOverride` (the
     * owning interaction's stored thread) wins when given, so
     * callback-derived messages keep the interaction's topic even if
     * the tap carried no thread. Edits stay in place (Telegram keeps
     * the edited message in its topic).
     *
     * Transversal hardening (shared with the sale path):
     * - Card-lost recovery: a dead tapped message NEVER throws away
     *   state — drafts/interactions are already persisted, so the
     *   current content is rendered into a NEW replacement card which
     *   is adopted (`cardMessageId`) when `own` is given. `message is
     *   not modified` is success (no duplicate card).
     * - Single-ACTIVE-card: the new foreground card deactivates stale
     *   sibling keyboards (same actor, same thread) when `own` is given.
     * - Length guard: over-long cards travel as same-thread follow-ups
     *   (first part keeps the edit/replacement path + keyboard).
     */
    async function sendLabeled(
      responseText: string,
      replyMarkup: InlineKeyboardMarkup,
      threadOverride?: number,
      own?: Interaction,
    ): Promise<void> {
      await ackOwnedReceipt();
      if (own !== undefined) {
        deactivateStaleForegroundCards(own.id, own.type);
      }
      const parts = splitTelegramText(responseText).map((part) =>
        withOperator(part, targetActorName),
      );
      const labeled = parts[0] ?? withOperator(responseText, targetActorName);
      const followUps = parts.slice(1);
      const thread = threadOverride ?? replyCtx.messageThreadId;
      const adopt = (response: unknown): void => {
        if (own === undefined) {
          return;
        }
        const sentId = extractSentMessageId(response);
        if (sentId !== undefined) {
          deps.interactions.touch(own.id, { cardMessageId: sentId });
          persistAll();
        }
      };
      if (fromCallback && callbackMessageId !== undefined) {
        try {
          await deps.client.editMessageText({
            chatId: targetChatId,
            messageId: callbackMessageId,
            text: labeled,
            replyMarkup,
          });
        } catch (error) {
          if (!isNotModifiedError(error)) {
            if (!isCardLostError(error)) {
              throw error;
            }
            adopt(
              await deps.client.sendMessage({
                chatId: targetChatId,
                text: labeled,
                replyMarkup,
                ...(thread !== undefined ? { messageThreadId: thread } : {}),
              }),
            );
          }
        }
      } else {
        adopt(
          await deps.client.sendMessage({
            chatId: targetChatId,
            text: labeled,
            replyMarkup,
            ...(thread !== undefined ? { messageThreadId: thread } : {}),
          }),
        );
      }
      for (const extra of followUps) {
        await deps.client.sendMessage({
          chatId: targetChatId,
          text: extra,
          ...(thread !== undefined ? { messageThreadId: thread } : {}),
        });
      }
      await ackOwnedReceipt();
    }

    /** Reply in place (edit) for button taps, fresh message otherwise. */
    async function respond(responseText: string, section?: string): Promise<void> {
      await ackOwnedReceipt();
      const interaction = createInteraction(
        section === undefined ? 'HOME' : sectionInteractionType(section),
      );
      const markup =
        section !== undefined
          ? sectionKeyboard(section, interaction.id)
          : homeKeyboard(interaction.id);
      persistAll();
      // Same transport as every other legacy card (recovery + adoption
      // + deactivation + length guard ride sendLabeled).
      await sendLabeled(responseText, markup, targetThreadId, interaction);
      await ackOwnedReceipt();
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
        await sendLabeled(responseText, homeKeyboard(home.id), undefined, home);
        return;
      }
      const interaction = activeOperationInteraction() ?? createInteraction('OPERATION');
      persistAll();
      await sendLabeled(responseText, draftKeyboard(interaction.id), undefined, interaction);
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
      // the peer starts their own search. Both coexist. The SEARCH_INPUT
      // (`prompt`) is seeded as the Volver parent so results never fall
      // back to Home — Volver returns to the wizard, Home stays explicit.
      if (!serviceBrowse && containsPhoneCandidate(identifier)) {
        const interaction = seedNavParent(createInteraction('SEARCH', { offset: 0 }));
        await renderCustomerSearch(interaction, identifier);
        return;
      }
      if (!serviceBrowse) {
        const interaction = seedNavParent(createInteraction('SEARCH', { offset: 0 }));
        await renderAccountSearch(interaction, identifier);
        return;
      }
      const interaction = seedNavParent(createInteraction('SEARCH', { offset: 0 }));
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
        transitionTo(interaction, 'account-list', { query, offset: 0 });
        persistAll();
        await sendLabeled(
          ACCOUNT_NOT_FOUND_TEXT,
          accountSearchKeyboard(interaction.id),
          interaction.messageThreadId,
          interaction,
        );
        return;
      }
      if (total === 1) {
        const only = accounts[0] as ServiceAccount;
        rememberAccountSelection(only);
        transitionTo(interaction, 'account-detail', {
          query,
          selectedAccount: {
            id: only.id,
            servicio: only.servicio,
            identifier: only.identifier,
          },
          selectedIndex: 0,
        });
        persistAll();
        await sendLabeled(
          formatAccountCard(only),
          accountSearchKeyboard(interaction.id),
          interaction.messageThreadId,
          interaction,
        );
        return;
      }
      const offset =
        typeof interaction.state['offset'] === 'number'
          ? (interaction.state['offset'] as number)
          : 0;
      const safeOffset = Math.min(Math.max(offset, 0), Math.max(total - 1, 0));
      const page = accounts.slice(safeOffset, safeOffset + SEARCH_PAGE_SIZE);
      transitionTo(interaction, 'account-list', {
        query,
        offset: safeOffset,
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
        interaction,
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
      transitionTo(interaction, 'account-detail', {
        query,
        selectedAccount: {
          id: account.id,
          servicio: account.servicio,
          identifier: account.identifier,
        },
        selectedIndex: accountIndex,
      });
      persistAll();
      await sendLabeled(
        formatAccountCard(account),
        accountSearchKeyboard(interaction.id),
        interaction.messageThreadId,
        interaction,
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
        transitionTo(interaction, 'customer-list', { query, offset: 0 });
        persistAll();
        await sendLabeled(
          PHONE_NOT_FOUND_TEXT,
          phoneSearchKeyboard(interaction.id),
          interaction.messageThreadId,
          interaction,
        );
        return;
      }
      if (total === 1) {
        const only = customers[0] as Customer;
        rememberCustomerSelection(only);
        transitionTo(interaction, 'customer-detail', {
          query,
          selectedCustomer: { id: only.id, nombre: only.nombre },
          selectedIndex: 0,
        });
        persistAll();
        await sendLabeled(
          formatCustomerCard(only),
          phoneSearchKeyboard(interaction.id),
          interaction.messageThreadId,
          interaction,
        );
        return;
      }
      const offset =
        typeof interaction.state['offset'] === 'number'
          ? (interaction.state['offset'] as number)
          : 0;
      const safeOffset = Math.min(Math.max(offset, 0), Math.max(total - 1, 0));
      const page = customers.slice(safeOffset, safeOffset + SEARCH_PAGE_SIZE);
      transitionTo(interaction, 'customer-list', {
        query,
        offset: safeOffset,
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
        interaction,
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
      transitionTo(interaction, 'customer-detail', {
        query,
        selectedCustomer: { id: customer.id, nombre: customer.nombre },
        selectedIndex: customerIndex,
      });
      persistAll();
      await sendLabeled(
        formatCustomerCard(customer),
        phoneSearchKeyboard(interaction.id),
        interaction.messageThreadId,
        interaction,
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

    /**
     * Context precedence (explicit current-message identifier ALWAYS
     * beats interaction selection > prior operator context >
     * ask-missing): extracts the identifier stated in THIS update's text
     * (L2 phone/email/account kinds first, else deterministic fallback
     * extractors over the raw text), regardless of which layer routed it.
     * Applies to account/phone/customer/assignment identifiers.
     */
    function extractIdentifierFromText(): string | undefined {
      if (decision.layer === 'L2') {
        const parse = decision.parse;
        if (parse.kind === 'phone') {
          return parse.raw;
        }
        if (parse.kind === 'email' || parse.kind === 'account') {
          return parse.value;
        }
      }
      const email = parseEmail(text);
      if (email !== null) {
        return email.value;
      }
      const phone = parsePhone(text);
      if (phone !== null) {
        return phone.raw;
      }
      const account = extractEmbeddedAccount(text);
      if (account !== null) {
        return account.value;
      }
      return undefined;
    }

    interface ExplicitCredentialResolution {
      bundles: CredentialBundle[];
      customer?: Customer;
      account?: ServiceAccount;
    }

    /**
     * Resolves an explicit identifier to credential bundles WITHOUT
     * touching search/grouping/identity rules: phone-like identifiers
     * travel the phone seam (grouped to customers), neutral identifiers
     * travel the account seam (grouped to accounts), anything else falls
     * back to the safe substring search mapped to holding customers.
     * Single-customer/single-account resolutions also refresh the
     * actor's own selection stores so the new resolution becomes the
     * operator context for later bare repeats.
     */
    async function bundlesForExplicitIdentifier(
      identifier: string,
    ): Promise<ExplicitCredentialResolution | null> {
      const trimmed = identifier.trim();
      if (trimmed === '') {
        return null;
      }
      if (containsPhoneCandidate(trimmed)) {
        const customers = await deps.repos.searchCustomersByPhone(trimmed);
        if (customers.length === 1) {
          const only = customers[0] as Customer;
          rememberCustomerSelection(only);
          return {
            bundles: await deps.repos.getCredentialBundlesForCustomer(only.id),
            customer: only,
          };
        }
        if (customers.length > 1) {
          const union: CredentialBundle[] = [];
          for (const customer of customers) {
            union.push(
              ...(await deps.repos.getCredentialBundlesForCustomer(customer.id)),
            );
          }
          return { bundles: union };
        }
        return { bundles: [] };
      }
      const accounts = await deps.repos.searchServiceAccounts(trimmed);
      if (accounts.length > 0) {
        const union: CredentialBundle[] = [];
        for (const account of accounts) {
          union.push(...(await deps.repos.getCredentialBundlesForAccount(account.id)));
        }
        if (accounts.length === 1) {
          const only = accounts[0] as ServiceAccount;
          rememberAccountSelection(only);
          return { bundles: union, account: only };
        }
        return { bundles: union };
      }
      const rows = await deps.repos.searchAccounts(trimmed);
      const names = [...new Set(rows.map((row) => row.nombre))];
      if (names.length === 0) {
        return { bundles: [] };
      }
      const union: CredentialBundle[] = [];
      let single: Customer | undefined;
      for (const name of names) {
        const key = name.trim().toLowerCase();
        const bundles = await deps.repos.getCredentialBundlesForCustomer(key);
        if (bundles.length === 0) {
          continue;
        }
        union.push(...bundles);
        if (names.length === 1) {
          single = { id: key, nombre: name, phones: [], subscriptions: [] };
        }
      }
      if (single !== undefined) {
        rememberCustomerSelection(single);
        return { bundles: union, customer: single };
      }
      return { bundles: union };
    }

    /** Actor's own latest phone query (search context) — preferred when usable. */
    function preferredPhoneQuery(): string | undefined {
      const query = resolveOwnSearchQuery();
      if (query !== undefined && containsPhoneCandidate(query)) {
        return query;
      }
      return undefined;
    }

    /**
     * Effective Netflix PIN for ONE bundle at render time: the contextual
     * phone wins when usable and matching the assignment, else the
     * assignment-unequivocal PIN carried by the bundle, else undefined
     * (the caller asks/disambiguates — never arbitrary, never stale).
     * Non-Netflix bundles pass through untouched.
     */
    function bundleWithEffectivePin(
      bundle: CredentialBundle,
      phoneRaw?: string,
    ): CredentialBundle {
      if (bundle.service !== 'netflix') {
        return bundle;
      }
      const pin =
        resolveNetflixPin(bundle.customerPhones, phoneRaw) ?? bundle.pin;
      if (pin === undefined || pin === bundle.pin) {
        return bundle;
      }
      return { ...bundle, pin };
    }

    /** Numerals for assignment/phone option buttons — UX only, never resolution keys. */
    const OPTION_NUMERALS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

    /**
     * Renders ONE sensitive card + safe-ref audit (no secrets in logs).
     * The WhatsApp button is AUTOMATIC whenever bundle+phone+E.164 are
     * unambiguous (datos → 1 tap → WhatsApp — never type "abre whatsapp"
     * after); ambiguous phones stay button-less (the explicit WhatsApp
     * flow asks first). Single-card: callback-derived renders edit the
     * SAME card in place via `sendLabeled`.
     */
    async function renderCredentialDirect(
      interaction: Interaction,
      bundle: CredentialBundle,
      refs: CredentialRefs,
    ): Promise<void> {
      const preferred = preferredPhoneQuery();
      const effective = bundleWithEffectivePin(bundle, preferred);
      const target = resolveWhatsAppTarget(effective.customerPhones, preferred);
      let whatsappUrl: string | undefined;
      let suffix = '';
      let delivered = effective;
      if (target.kind === 'direct') {
        if (effective.service === 'netflix' && effective.pin === undefined) {
          const pin = deriveNetflixProfilePin(target.identity);
          if (pin !== undefined) {
            delivered = { ...effective, pin };
          }
        }
        whatsappUrl = buildWhatsAppUrl(
          target.identity,
          renderCredentialWhatsAppText(delivered),
        );
        suffix = `\n\n${WHATSAPP_PREPARED_TEXT}`;
        auditor.record({
          chatId: targetChatId,
          actorTelegramUserId: targetActorId,
          ...(targetActorName !== undefined ? { actorName: targetActorName } : {}),
          actionType: 'whatsapp.link_prepared',
          entity: credentialAuditRef(delivered),
          metadata: {
            service: delivered.service,
            accountRef: delivered.accountIdentifier,
            customerRef: delivered.customerName,
          },
        });
      }
      transitionTo(interaction, 'credentials-detail', {
        ...refs,
        selectedAssignmentKey: credentialAssignmentKey(bundle),
      });
      persistAll();
      auditor.record({
        chatId: targetChatId,
        actorTelegramUserId: targetActorId,
        ...(targetActorName !== undefined ? { actorName: targetActorName } : {}),
        actionType: 'credential.viewed',
        entity: credentialAuditRef(delivered),
        metadata: {
          service: delivered.service,
          accountRef: delivered.accountIdentifier,
          customerRef: delivered.customerName,
        },
      });
      logger.info(
        { userId: targetActorId, chatId: targetChatId, updateId, action: 'credentials-direct' },
        'Rendered credential card',
      );
      await sendLabeled(
        `${renderCredentialCard({
          serviceLabel: delivered.serviceLabel,
          accountIdentifier: delivered.accountIdentifier,
          accountPassword: delivered.accountPassword,
          profile: delivered.profile,
          accountType: delivered.accountType,
          customerName: delivered.customerName,
          fechaFin: delivered.fechaFin,
          ...(delivered.pin !== undefined ? { pin: delivered.pin } : {}),
        })}${suffix}`,
        credentialCardKeyboard(interaction.id, whatsappUrl, {
          showServices: refs.total > 1,
        }),
        interaction.messageThreadId,
        interaction,
      );
    }

    /**
     * Multi-assignment FIRST card: compact per-assignment blocks with
     * clear per-assignment buttons (stable assignment keys stored in
     * state — numbering is UX only). Never a long card + generic Datos
     * button. The same renderer serves the WhatsApp variant (selection
     * continues into phone targeting through the stored `whatsapp` flag).
     */
    async function renderCredentialAsk(
      interaction: Interaction,
      options: CredentialBundle[],
      refs: CredentialRefs,
      viaWhatsApp = false,
    ): Promise<void> {
      const labels = credentialOptionLabels(options);
      // Single-client scope: the card context already names the client, so
      // blocks carry service + profile + FULL account identifier only (no
      // client repetition — the identifier is the real differentiator).
      // Multi-client scope (shared account): the header names nobody, so
      // each block prefixes the holding client. Blocks always keep the
      // full identifier; button labels may truncate (controlled `…`).
      const multiCustomer =
        new Set(options.map((option) => option.customerName.trim().toLowerCase())).size > 1;
      transitionTo(interaction, viaWhatsApp ? 'whatsapp-list' : 'credentials-list', {
        ...refs,
        total: options.length,
        assignmentKeys: options.map((option) => credentialAssignmentKey(option)),
        ...(viaWhatsApp ? { whatsapp: true } : {}),
      });
      persistAll();
      logger.info(
        { userId: targetActorId, chatId: targetChatId, updateId, action: 'credentials-ask' },
        'Rendered credential disambiguation',
      );
      await sendLabeled(
        renderCredentialAssignmentList(
          options.length,
          options.map((option, index) => {
            const derived = deriveExpiryStatus(option.fechaFin);
            return {
              numeral: OPTION_NUMERALS[index] ?? '•',
              serviceLabel: option.serviceLabel,
              profile: option.profile,
              disambiguator: multiCustomer
                ? `${option.customerName} · ${option.accountIdentifier}`
                : option.accountIdentifier,
              estatus: derived.estatus,
              dias: derived.dias,
              fechaFin: option.fechaFin,
              paisCuenta: option.paisCuenta,
            };
          }),
        ),
        credentialDisambiguationKeyboard(labels, { interactionId: interaction.id }),
        interaction.messageThreadId,
        interaction,
      );
    }

    /**
     * Newest owned SEARCH interaction carrying a credential selection —
     * the reuse target for bare NL repeats (`dame los datos` with no new
     * identifier), so the datos card chains onto the client/account card
     * (same interaction, same-card edits, Volver-safe) instead of opening
     * a disconnected interaction. Explicit identifiers always open fresh.
     */
    function newestOwnSearchInteraction(): Interaction | undefined {
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
        const selection = readCredentialSelection(candidate);
        if (selection.customer === undefined && selection.account === undefined) {
          continue;
        }
        if (best === undefined || candidate.updatedAt >= best.updatedAt) {
          best = candidate;
        }
      }
      return best;
    }

    /**
     * SHOW_CREDENTIALS explicit entry: explicit current-message
     * identifier → interaction selection → prior operator context →
     * ask-missing. Repeats are idempotent (same identifier/context →
     * same logical card, never draft/Home/stale/UNKNOWN). Single-card:
     * a button tap reuses its OWN interaction (Volver chain + same-card
     * edits survive); only fresh NL creates a new interaction.
     */
    async function runCredentialsFlow(
      origin: Interaction | undefined,
      serviceFilter?: MockService,
      explicitIdentifier?: string,
    ): Promise<void> {
      const identifier = explicitIdentifier ?? extractIdentifierFromText();
      if (identifier !== undefined) {
        await runExplicitCredentialsFlow(identifier, serviceFilter, false, origin);
        return;
      }
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
          view,
        );
        return;
      }
      const reuse = origin ?? newestOwnSearchInteraction();
      const interaction =
        reuse !== undefined
          ? deps.interactions.get(reuse.id) ?? reuse
          : seedNavParent(createInteraction('SEARCH', { offset: 0 }));
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
        interaction,
      );
    }

    /**
     * Explicit-identifier credential entry (shared by datos and
     * WhatsApp flows): the current message names the target, so it
     * ALWAYS beats stored selection/context. A bare repeat (no new
     * identifier) reuses the refreshed context — same logical result.
     * An explicit identifier matching nothing answers the honest
     * no-context guide — never a stale card, never Home, never UNKNOWN.
     * Unambiguous resolutions mirror into the interaction state so they
     * become the new operator context. Fastest path: an unambiguous
     * identifier renders the credential card DIRECTLY (no prior card,
     * no selector) with automatic WhatsApp; multi-assignment renders the
     * assignment selector FIRST (per-assignment direct buttons, stable
     * keys, numbering UX-only — never a generic Datos step).
     */
    async function runExplicitCredentialsFlow(
      identifier: string,
      serviceFilter: MockService | undefined,
      viaWhatsApp: boolean,
      reuse?: Interaction,
    ): Promise<void> {
      const explicit = await bundlesForExplicitIdentifier(identifier);
      if (explicit === null || explicit.bundles.length === 0) {
        const view = createInteraction('SEARCH', { view: 'prompt' });
        persistAll();
        await sendLabeled(
          renderCredentialNoContext(),
          sectionKeyboard('buscar', view.id),
          view.messageThreadId,
          view,
        );
        return;
      }
      const selection: CredentialSelection = {};
      if (explicit.customer !== undefined) {
        selection.customer = { id: explicit.customer.id, nombre: explicit.customer.nombre };
      }
      if (explicit.account !== undefined) {
        selection.account = {
          id: explicit.account.id,
          servicio: explicit.account.servicio,
          identifier: explicit.account.identifier,
        };
      }
      const interaction =
        reuse !== undefined
          ? deps.interactions.get(reuse.id) ?? reuse
          : seedNavParent(createInteraction('SEARCH', { offset: 0 }));
      let view = resolveCredentialView(explicit.bundles, serviceFilter);
      if (view.kind === 'none' && serviceFilter !== undefined) {
        view = resolveCredentialView(explicit.bundles, undefined);
      }
      const refs = credentialRefsFor(selection, serviceFilter, explicit.bundles.length);
      deps.interactions.touch(interaction.id, {
        ...refs,
        ...(selection.customer !== undefined
          ? { selectedCustomer: selection.customer }
          : {}),
        ...(selection.account !== undefined ? { selectedAccount: selection.account } : {}),
        explicitIdentifier: identifier.trim(),
      });
      const touched = deps.interactions.get(interaction.id) ?? interaction;
      if (view.kind === 'direct') {
        if (viaWhatsApp) {
          await renderWhatsAppForBundle(touched, view.bundle, refs, preferredPhoneQuery());
          return;
        }
        await renderCredentialDirect(touched, view.bundle, refs);
        return;
      }
      if (view.kind === 'ask') {
        await renderCredentialAsk(touched, view.options, refs, viaWhatsApp);
        return;
      }
      persistAll();
      await sendLabeled(
        renderCredentialNoContext(),
        sectionKeyboard('buscar', touched.id),
        touched.messageThreadId,
        touched,
      );
    }

    /**
     * Re-resolves candidate bundles for an owned interaction from its
     * secret-free state: single customer/account refs, or the stored
     * explicit identifier (union resolutions). Powers selector taps,
     * [← Servicios] restores and phone-choice taps without persisting
     * any secret.
     */
    async function candidateBundlesForState(state: Record<string, unknown>): Promise<{
      bundles: CredentialBundle[];
      selection: CredentialSelection;
    }> {
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
      if (
        selection.customer !== undefined ||
        selection.account !== undefined
      ) {
        const bundles = await credentialBundlesFor(selection);
        let view = resolveCredentialView(bundles, serviceFilter);
        if (view.kind === 'none' && serviceFilter !== undefined) {
          view = resolveCredentialView(bundles, undefined);
        }
        if (view.kind === 'direct') {
          return { bundles: [view.bundle], selection };
        }
        if (view.kind === 'ask') {
          return { bundles: view.options, selection };
        }
        return { bundles, selection };
      }
      const storedIdentifier = state['explicitIdentifier'];
      if (typeof storedIdentifier === 'string' && storedIdentifier.trim() !== '') {
        const explicit = await bundlesForExplicitIdentifier(storedIdentifier);
        const bundles = explicit?.bundles ?? [];
        let view = resolveCredentialView(bundles, serviceFilter);
        if (view.kind === 'none' && serviceFilter !== undefined) {
          view = resolveCredentialView(bundles, undefined);
        }
        if (view.kind === 'direct') {
          return { bundles: [view.bundle], selection };
        }
        if (view.kind === 'ask') {
          return { bundles: view.options, selection };
        }
        return { bundles, selection };
      }
      return { bundles: [], selection };
    }

    /** Resolves ONE bundle out of stored stable assignment keys (numbering is UX only). */
    function bundleForOptionIndex(
      bundles: CredentialBundle[],
      state: Record<string, unknown>,
      optionIndex: number,
    ): CredentialBundle | undefined {
      const keys = Array.isArray(state['assignmentKeys'])
        ? (state['assignmentKeys'] as unknown[]).filter(
            (key): key is string => typeof key === 'string',
          )
        : [];
      const key = keys[optionIndex];
      if (key !== undefined) {
        const match = bundles.find((bundle) => credentialAssignmentKey(bundle) === key);
        if (match !== undefined) {
          return match;
        }
      }
      return bundles[optionIndex];
    }

    /** Credential card from the owned disambiguation list (stable keys, never persisted secrets). */
    async function renderCredentialSelection(
      interaction: Interaction,
      optionIndex: number,
    ): Promise<void> {
      const state = interaction.state;
      const { bundles, selection } = await candidateBundlesForState(state);
      if (bundles.length === 0) {
        await ackStale('view');
        return;
      }
      const storedFilter = state['serviceFilter'];
      const serviceFilter =
        storedFilter === 'netflix' || storedFilter === 'flujotv'
          ? (storedFilter as MockService)
          : undefined;
      const bundle = bundleForOptionIndex(bundles, state, optionIndex);
      if (bundle === undefined) {
        await ackStale('view');
        return;
      }
      const refs = credentialRefsFor(selection, serviceFilter, bundles.length);
      if (state['whatsapp'] === true) {
        deps.interactions.touch(interaction.id, { optionIndex });
        await renderWhatsAppForBundle(interaction, bundle, refs, preferredPhoneQuery(), optionIndex);
        return;
      }
      await renderCredentialDirect(interaction, bundle, refs);
    }

    /** Rebuilds the owned disambiguation list ([← Servicios] / Volver from a card/list). */
    async function renderCredentialList(interaction: Interaction): Promise<void> {
      const state = interaction.state;
      const { bundles, selection } = await candidateBundlesForState(state);
      const storedFilter = state['serviceFilter'];
      const serviceFilter =
        storedFilter === 'netflix' || storedFilter === 'flujotv'
          ? (storedFilter as MockService)
          : undefined;
      const refs = credentialRefsFor(selection, serviceFilter, bundles.length);
      const viaWhatsApp = state['whatsapp'] === true;
      if (bundles.length > 1) {
        await renderCredentialAsk(interaction, bundles, refs, viaWhatsApp);
        return;
      }
      if (bundles.length === 1) {
        const only = bundles[0] as CredentialBundle;
        if (viaWhatsApp) {
          const storedIndex = state['optionIndex'];
          await renderWhatsAppForBundle(
            interaction,
            only,
            refs,
            preferredPhoneQuery(),
            typeof storedIndex === 'number' ? storedIndex : undefined,
          );
          return;
        }
        await renderCredentialDirect(interaction, only, refs);
        return;
      }
      persistAll();
      await sendLabeled(
        renderCredentialNoContext(),
        sectionKeyboard('buscar', interaction.id),
        interaction.messageThreadId,
        interaction,
      );
    }

    /**
     * Slice B — direct WhatsApp delivery (wa.me, prefilled, manual send).
     *
     * The `💬 Abrir WhatsApp` URL button (L1, no callback) and the L2
     * WhatsApp phrases plus L3 semantic variants ALL converge here — same
     * context resolution as SHOW_CREDENTIALS (the actor's OWN selections
     * only, never a peer's), same deterministic bundle tool, plus phone
     * targeting through the slice-A identity (`identifyPhone`: explicit
     * `+CC` priority, legacy only when safely decidable).
     *
     * Read-only: drafts are never created, updated, or cancelled here; no
     * business state is mutated. Semantics are NEVER "sent": the UI says
     * `💬 WhatsApp preparado.` and shows the direct URL button (at most a
     * `whatsapp.link_prepared` audit trace with safe refs only). The full
     * wa.me URL carries credentialed text — it is transient (button
     * only), NEVER logged, NEVER persisted, NEVER sent to Gemini or
     * AlertService.
     */

    /** Renders ONE bundle's delivery: direct link, phone ask, or no-link. */
    async function renderWhatsAppDirect(
      interaction: Interaction,
      bundle: CredentialBundle,
      refs: CredentialRefs,
      phoneRaw?: string,
    ): Promise<void> {
      const effective = bundleWithEffectivePin(bundle, phoneRaw ?? preferredPhoneQuery());
      const target = resolveWhatsAppTarget(effective.customerPhones, phoneRaw);
      if (target.kind === 'direct') {
        let delivered = effective;
        if (effective.service === 'netflix' && effective.pin === undefined) {
          const pin = deriveNetflixProfilePin(target.identity);
          if (pin !== undefined) {
            delivered = { ...effective, pin };
          }
        }
        const text = renderCredentialWhatsAppText(delivered);
        const url = buildWhatsAppUrl(target.identity, text);
        transitionTo(interaction, 'whatsapp-detail', {
          ...refs,
          selectedAssignmentKey: credentialAssignmentKey(bundle),
        });
        persistAll();
        auditor.record({
          chatId: targetChatId,
          actorTelegramUserId: targetActorId,
          ...(targetActorName !== undefined ? { actorName: targetActorName } : {}),
          actionType: 'whatsapp.link_prepared',
          entity: credentialAuditRef(bundle),
          metadata: {
            service: bundle.service,
            accountRef: bundle.accountIdentifier,
            customerRef: bundle.customerName,
          },
        });
        logger.info(
          { userId: targetActorId, chatId: targetChatId, updateId, action: 'whatsapp-direct' },
          'Prepared WhatsApp link',
        );
        await sendLabeled(
          `${renderCredentialCard({
            serviceLabel: delivered.serviceLabel,
            accountIdentifier: delivered.accountIdentifier,
            accountPassword: delivered.accountPassword,
            profile: delivered.profile,
            accountType: delivered.accountType,
            customerName: delivered.customerName,
            fechaFin: delivered.fechaFin,
            ...(delivered.pin !== undefined ? { pin: delivered.pin } : {}),
          })}\n\n${WHATSAPP_PREPARED_TEXT}`,
          credentialCardKeyboard(interaction.id, url, {
            showServices: refs.total > 1,
          }),
          interaction.messageThreadId,
          interaction,
        );
        return;
      }
      if (target.kind === 'ask') {
        const phones = target.options.map((option) => option.raw);
        transitionTo(interaction, 'whatsapp-phones', {
          ...refs,
          phones,
          selectedAssignmentKey: credentialAssignmentKey(bundle),
        });
        persistAll();
        logger.info(
          { userId: targetActorId, chatId: targetChatId, updateId, action: 'whatsapp-ask' },
          'Asked WhatsApp target phone',
        );
        await sendLabeled(
          WHATSAPP_ASK_PHONE_TEXT,
          credentialDisambiguationKeyboard(phones, { interactionId: interaction.id }),
          interaction.messageThreadId,
          interaction,
        );
        return;
      }
      transitionTo(interaction, 'whatsapp-nolink', { ...refs });
      persistAll();
      logger.info(
        { userId: targetActorId, chatId: targetChatId, updateId, action: 'whatsapp-nolink' },
        'No usable WhatsApp number',
      );
      const others =
        target.others.length > 0 ? `\n\nNúmeros registrados: ${target.others.join(' / ')}` : '';
      await sendLabeled(
        `${WHATSAPP_NO_NUMBER_TEXT}${others}`,
        credentialCardKeyboard(interaction.id),
        interaction.messageThreadId,
        interaction,
      );
    }

    /** Stores the ask-path option index so the later phone tap re-resolves. */
    async function renderWhatsAppForBundle(
      interaction: Interaction,
      bundle: CredentialBundle,
      refs: CredentialRefs,
      phoneRaw?: string,
      optionIndex?: number,
    ): Promise<void> {
      if (optionIndex !== undefined) {
        deps.interactions.touch(interaction.id, { optionIndex });
      }
      await renderWhatsAppDirect(interaction, bundle, refs, phoneRaw);
    }

    async function runWhatsAppFlow(
      origin: Interaction | undefined,
      serviceFilter?: MockService,
      explicitIdentifier?: string,
    ): Promise<void> {
      const identifier = explicitIdentifier ?? extractIdentifierFromText();
      if (identifier !== undefined) {
        await runExplicitCredentialsFlow(identifier, serviceFilter, true, origin);
        return;
      }
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
      const reuse = origin ?? newestOwnSearchInteraction();
      const interaction =
        reuse !== undefined
          ? deps.interactions.get(reuse.id) ?? reuse
          : seedNavParent(createInteraction('SEARCH', { offset: 0 }));
      let view = resolveCredentialView(bundles, serviceFilter);
      if (view.kind === 'none' && serviceFilter !== undefined) {
        view = resolveCredentialView(bundles, undefined);
      }
      const refs = credentialRefsFor(selection, serviceFilter, bundles.length);
      if (view.kind === 'direct') {
        await renderWhatsAppForBundle(interaction, view.bundle, refs, preferredPhoneQuery());
        return;
      }
      if (view.kind === 'ask') {
        await renderCredentialAsk(interaction, view.options, refs, true);
        return;
      }
      persistAll();
      await sendLabeled(
        renderCredentialNoContext(),
        sectionKeyboard('buscar', interaction.id),
        interaction.messageThreadId,
        interaction,
      );
    }

    /** WhatsApp target-phone tap from the owned real-number list. */
    async function renderWhatsAppPhoneChoice(
      interaction: Interaction,
      phoneIndex: number,
    ): Promise<void> {
      const state = interaction.state;
      const phones = Array.isArray(state['phones'])
        ? (state['phones'] as unknown[]).filter(
            (phone): phone is string => typeof phone === 'string',
          )
        : [];
      const phoneRaw = phones[phoneIndex];
      if (phoneRaw === undefined) {
        await ackStale('view');
        return;
      }
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
      const { bundles } = await candidateBundlesForState(state);
      let bundle: CredentialBundle | undefined;
      if (bundles.length === 1) {
        bundle = bundles[0];
      } else if (bundles.length > 1) {
        const storedIndex = state['optionIndex'];
        bundle =
          typeof storedIndex === 'number'
            ? bundleForOptionIndex(bundles, state, storedIndex)
            : undefined;
      }
      if (bundle === undefined) {
        await ackStale('view');
        return;
      }
      const refs = credentialRefsFor(selection, serviceFilter, bundles.length);
      await renderWhatsAppDirect(interaction, bundle, refs, phoneRaw);
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
        view,
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
      /**
       * Slice B entry (additive): with sale wiring, OPERAR shows ONLY
       * currently-implemented options (Venta nueva — no Renovación, no
       * full Vencidos/Inventario/Caja, no Bolsa/Cierre). Without sale
       * wiring the legacy demo draft shell is unchanged.
       */
      if (saleToolDeps !== undefined) {
        const operation = activeOperationInteraction() ?? createInteraction('OPERATION');
        const seeded = seedSaleNavParent(operation, 'home');
        const entered = transitionTo(seeded, 'sale-entry');
        persistAll();
        auditDraft('sale.entry', {});
        await sendLabeled(
          SALE_ENTRY_TEXT,
          saleEntryKeyboard(entered.id),
          thread ?? entered.messageThreadId,
          entered,
        );
        return;
      }
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
        operation,
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
        view,
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
        view,
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
        view,
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
        view,
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
        transitionTo(interaction, 'list', { query, offset: 0 });
        persistAll();
        await sendLabeled(
          renderLegacyNotFound(query),
          sectionKeyboard('buscar', interaction.id),
          interaction.messageThreadId,
          interaction,
        );
        return;
      }
      const safeOffset = Math.min(Math.max(offset, 0), Math.max(total - 1, 0));
      const page = rows.slice(safeOffset, safeOffset + SEARCH_PAGE_SIZE);
      transitionTo(interaction, 'list', {
        query,
        offset: safeOffset,
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
        interaction,
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
      transitionTo(interaction, 'detail', {
        query,
        selectedIndex: globalIndex,
      });
      persistAll();
      await sendLabeled(
        renderLegacyDetail(row, globalIndex, rows.length),
        sectionKeyboard('buscar', interaction.id),
        interaction.messageThreadId,
        interaction,
      );
    }

    /**
     * Re-renders a stored nav view WITHOUT pushing (the pop already
     * restored the snapshot, so same-view transitions stay push-free and
     * round-trips preserve the stack). Same-card edits via sendLabeled.
     */
    async function renderStoredView(target: Interaction, view: string): Promise<void> {
      const state = (deps.interactions.get(target.id) ?? target).state;
      const query = typeof state['query'] === 'string' ? (state['query'] as string) : '';
      switch (view) {
        case 'home': {
          await handleHome(target);
          return;
        }
        case 'sale-entry': {
          // The OPERAR entry card: exact producing view, SAME card,
          // draft intact (navigation never touches the draft store).
          persistAll();
          await sendSaleCard(
            target,
            SALE_ENTRY_TEXT,
            saleEntryKeyboard(target.id),
            target.messageThreadId,
          );
          return;
        }
        case 'prompt': {
          persistAll();
          await sendLabeled(
            SECTION_TEXTS['buscar'] ?? '🔎 BUSCAR',
            sectionKeyboard('buscar', target.id),
            target.messageThreadId,
            target,
          );
          return;
        }
        case 'list': {
          await renderSearchPage(target, query);
          return;
        }
        case 'customer-list': {
          await renderCustomerSearch(target, query);
          return;
        }
        case 'customer-detail': {
          const selected = state['selectedCustomer'] as
            | { id?: unknown; nombre?: unknown }
            | undefined;
          const selectedId = typeof selected?.id === 'string' ? selected.id : undefined;
          const customers = await deps.repos.searchCustomersByPhone(query);
          let index =
            typeof state['selectedIndex'] === 'number'
              ? (state['selectedIndex'] as number)
              : -1;
          if (selectedId !== undefined) {
            const found = customers.findIndex((customer) => customer.id === selectedId);
            if (found >= 0) {
              index = found;
            }
          }
          if (index >= 0 && customers[index] !== undefined) {
            await renderCustomerDetail(target, query, index);
            return;
          }
          if (customers.length > 0) {
            await renderCustomerSearch(target, query);
            return;
          }
          await ackStale('back');
          return;
        }
        case 'account-list': {
          await renderAccountSearch(target, query);
          return;
        }
        case 'account-detail': {
          const selected = state['selectedAccount'] as { id?: unknown } | undefined;
          const selectedId = typeof selected?.id === 'string' ? selected.id : undefined;
          const accounts = await deps.repos.searchServiceAccounts(query);
          let index =
            typeof state['selectedIndex'] === 'number'
              ? (state['selectedIndex'] as number)
              : -1;
          if (selectedId !== undefined) {
            const found = accounts.findIndex((account) => account.id === selectedId);
            if (found >= 0) {
              index = found;
            }
          }
          if (index >= 0 && accounts[index] !== undefined) {
            await renderAccountCard(target, query, index);
            return;
          }
          if (accounts.length > 0) {
            await renderAccountSearch(target, query);
            return;
          }
          await ackStale('back');
          return;
        }
        case 'detail': {
          const index =
            typeof state['selectedIndex'] === 'number'
              ? (state['selectedIndex'] as number)
              : 0;
          await renderAccountDetail(target, query, index);
          return;
        }
        case 'credentials-list':
        case 'whatsapp-list': {
          await renderCredentialList(target);
          return;
        }
        case 'credentials-detail': {
          const resolved = await candidateBundlesForState(state);
          const key =
            typeof state['selectedAssignmentKey'] === 'string'
              ? (state['selectedAssignmentKey'] as string)
              : undefined;
          const bundle =
            (key !== undefined
              ? resolved.bundles.find((candidate) => credentialAssignmentKey(candidate) === key)
              : undefined) ?? resolved.bundles[0];
          if (bundle === undefined) {
            await ackStale('back');
            return;
          }
          const storedFilter = state['serviceFilter'];
          const refs = credentialRefsFor(
            resolved.selection,
            storedFilter === 'netflix' || storedFilter === 'flujotv'
              ? storedFilter
              : undefined,
            resolved.bundles.length,
          );
          await renderCredentialDirect(target, bundle, refs);
          return;
        }
        case 'whatsapp-detail': {
          const resolved = await candidateBundlesForState(state);
          const key =
            typeof state['selectedAssignmentKey'] === 'string'
              ? (state['selectedAssignmentKey'] as string)
              : undefined;
          const bundle =
            (key !== undefined
              ? resolved.bundles.find((candidate) => credentialAssignmentKey(candidate) === key)
              : undefined) ?? resolved.bundles[0];
          if (bundle === undefined) {
            await ackStale('back');
            return;
          }
          const storedFilter = state['serviceFilter'];
          const refs = credentialRefsFor(
            resolved.selection,
            storedFilter === 'netflix' || storedFilter === 'flujotv'
              ? storedFilter
              : undefined,
            resolved.bundles.length,
          );
          await renderWhatsAppDirect(target, bundle, refs, preferredPhoneQuery());
          return;
        }
        case 'whatsapp-phones': {
          const phones = Array.isArray(state['phones'])
            ? (state['phones'] as unknown[]).filter(
                (phone): phone is string => typeof phone === 'string',
              )
            : [];
          if (phones.length === 0) {
            await renderCredentialList(target);
            return;
          }
          persistAll();
          await sendLabeled(
            WHATSAPP_ASK_PHONE_TEXT,
            credentialDisambiguationKeyboard(phones, { interactionId: target.id }),
            target.messageThreadId,
            target,
          );
          return;
        }
        case 'whatsapp-nolink': {
          await renderCredentialList(target);
          return;
        }
        default: {
          // Sale views (sale-batch/summary/pending/…) re-render the
          // producing VIEW against the intact draft: re-settle the
          // current draft (recompute → expectedSaleFields) and show it
          // on the SAME card. Navigation restores no business field —
          // phones are never swapped, drafts never dropped/cancelled.
          // HOTFIX 2: no open draft (terminal/frozen card) → safe no-op,
          // never a re-render, never a resurrection — the fresh Home
          // below owns continuation.
          if (view.startsWith('sale-') && saleToolDeps !== undefined) {
            if (saleToolDeps.store.get(owner) === undefined) {
              await ackStale('back');
              return;
            }
            const result = await refreshCurrentSale(saleActor(), saleToolDeps);
            auditSaleResult(result);
            deps.interactions.touch(target.id, { view: saleViewForResult(result) });
            persistAll();
            const freshTarget = deps.interactions.get(target.id) ?? target;
            await sendSaleCard(
              freshTarget,
              result.text,
              keyboardForSaleResult(result, freshTarget.id, result.whatsappUrl),
              freshTarget.messageThreadId,
            );
            return;
          }
          await ackStale('back');
          return;
        }
      }
    }

    /** Explicit root action: Home always, never via Volver fallback. */
    async function handleHome(interaction: Interaction): Promise<void> {
      const home = createInteraction('HOME');
      persistAll();
      await sendLabeled(HOME_TEXT, homeKeyboard(home.id), interaction.messageThreadId, home);
    }

    /**
     * Volver: pops the SAME interaction's nav stack and re-renders the
     * exact previous view (same-card edit when the tap came from a
     * callback). Empty stack: a ROOT view (`prompt` wizard, `sale-entry`,
     * or unset) renders Home — the single sanctioned Volver→Home case;
     * any other root view is a safe no-op — never an arbitrary Home,
     * never a selection change, never stack corruption. Navigation
     * never touches drafts (business state changes only through the
     * sale state machine: fold / confirm / cancel).
     */
    async function handleBack(interaction: Interaction): Promise<void> {
      const fresh = deps.interactions.get(interaction.id) ?? interaction;
      // HOTFIX 2: Back never resurrects a frozen SALE card — safe no-op
      // (brief note, zero mutation, zero render). Scoped to sale-managed
      // cards (stored operationId/sale view); legacy flows keep their
      // approved behavior.
      {
        const view = fresh.state['view'];
        const isSaleManaged =
          typeof fresh.state['operationId'] === 'string' ||
          (typeof view === 'string' && (view as string).startsWith('sale-'));
        if (fresh.status !== 'PENDING' && isSaleManaged) {
          await ackOwnedReceipt({ text: SALE_TERMINAL_STALE_TEXT });
          auditInteraction('interaction.stale_terminal_back', fresh, {});
          return;
        }
      }
      if (
        typeof fresh.state['view'] === 'string' &&
        (fresh.state['view'] as string).startsWith('sale-') &&
        typeof fresh.state['operationId'] === 'string'
      ) {
        saleMetrics.record(fresh.state['operationId'] as string, 'back');
      }
      const nav = navEntriesOf(fresh);
      if (nav.length === 0) {
        const current =
          typeof fresh.state['view'] === 'string'
            ? (fresh.state['view'] as string)
            : undefined;
        if (current === 'prompt' || current === 'sale-entry' || current === undefined) {
          await handleHome(fresh);
          return;
        }
        await ackStale('back');
        return;
      }
      const previous = nav[nav.length - 1] as NavEntry;
      const rest = nav.slice(0, -1);
      deps.interactions.touch(fresh.id, {
        ...previous.snap,
        view: previous.view,
        [NAV_KEY]: rest,
      });
      persistAll();
      const target = deps.interactions.get(fresh.id) ?? fresh;
      auditInteraction('interaction.back', target, {
        ...(typeof fresh.state['view'] === 'string' ? { fromView: fresh.state['view'] } : {}),
        toView: previous.view,
      });
      await renderStoredView(target, previous.view);
    }

    /** Owned-callback execution: ownership already verified by the caller. */
    async function executeOwned(
      action: string,
      interaction: Interaction,
    ): Promise<void> {
      /**
       * HOTFIX 2 operation gate: the tap names an operation (stored
       * `operationId`) that is no longer the actor's current one — a new
       * operation already owns the foreground. Mutate nothing; refresh
       * the CURRENT card so the operator sees live state (never delete,
       * cancel, or resurrect via the stale tap).
       */
      if (
        saleToolDeps !== undefined &&
        interaction.type === 'OPERATION' &&
        (action === 'confirm' ||
          action === 'cancel' ||
          action === 'correct' ||
          action === 'saleNew' ||
          action === 'saleEmergency' ||
          action === 'saleKeep' ||
          action === 'saleModNetflix' ||
          action === 'saleModFlujoShared' ||
          action === 'saleModFlujoComplete')
      ) {
        const open = saleToolDeps.store.get(owner);
        const gated = interaction.state['operationId'];
        if (
          open !== undefined &&
          typeof gated === 'string' &&
          gated !== open.operationId
        ) {
          auditInteraction('interaction.stale_operation', interaction, {
            requestedAction: action,
            expectedOperationId: open.operationId,
          });
          const current = activeOperationInteraction();
          if (current !== undefined) {
            const result = await refreshCurrentSale(saleActor(), saleToolDeps);
            auditSaleResult(result);
            await sendSaleResult(current, result, current.messageThreadId);
            return;
          }
        }
      }
      if (action === 'home') {
        // Explicit root action only — never a navigation fallback.
        await handleHome(interaction);
        return;
      }
      if (action === 'back') {
        // Volver = exact previous view of the SAME interaction
        // (Datos→Servicios→Cliente→Buscar→Home chain via the nav stack;
        // sale OPERATION cards pop the shared sale stack to the
        // entry/batch/… view, draft intact — never arbitrary Home).
        await handleBack(interaction);
        return;
      }
      if (action === 'buscar') {
        const view = createInteraction('SEARCH', { view: 'prompt' });
        persistAll();
        await sendLabeled(
          SECTION_TEXTS['buscar'] ?? '🔎 BUSCAR',
          sectionKeyboard('buscar', view.id),
          interaction.messageThreadId,
          view,
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
      if (action === 'services') {
        // [← Servicios]: semantic shortcut to ASSIGNMENT_SELECTOR inside
        // the SAME nav model (pushes the card, renders the selector in
        // place via the shared list renderer). Without a multi-option
        // selector to restore the tap is a safe no-op — never Home.
        if (
          interaction.type === 'SEARCH' &&
          (interaction.state['view'] === 'credentials-detail' ||
            interaction.state['view'] === 'whatsapp-detail' ||
            interaction.state['view'] === 'whatsapp-phones' ||
            interaction.state['view'] === 'whatsapp-nolink' ||
            interaction.state['view'] === 'credentials-list' ||
            interaction.state['view'] === 'whatsapp-list')
        ) {
          const total =
            typeof interaction.state['total'] === 'number'
              ? (interaction.state['total'] as number)
              : 0;
          if (total > 1) {
            await renderCredentialList(interaction);
            return;
          }
        }
        await ackStale('services');
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
        /**
         * Slice B (additive): an open/confirmed sale draft routes Confirm
         * through the atomic service (repeat taps answer `already
         * confirmed` with zero new rows); an open sale draft routes
         * Cancel through the sale cancel (persists nothing). Without a
         * sale draft the legacy demo path below runs unchanged.
         */
        if (saleToolDeps !== undefined && action === 'confirm' && hasSaleDraft()) {
          await runSaleConfirmFlow(interaction, interaction.messageThreadId);
          return;
        }
        if (saleToolDeps !== undefined && action === 'cancel' && hasOpenSaleDraft()) {
          await runSaleCancelFlow(interaction, interaction.messageThreadId);
          return;
        }
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
          await sendLabeled(text, homeKeyboard(home.id), interaction.messageThreadId, home);
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
        await sendLabeled(result.text, homeKeyboard(home.id), interaction.messageThreadId, home);
        return;
      }
      if (action === 'correct') {
        // Slice B (additive): sale corrections stay on the SAME sale
        // draft (the sale NL folds them in); otherwise the legacy guard.
        if (saleToolDeps !== undefined && hasOpenSaleDraft()) {
          deps.interactions.touch(interaction.id, { view: 'correct' });
          persistAll();
          await sendLabeled(
            CORRECTION_PROMPT_TEXT,
            draftKeyboard(interaction.id),
            interaction.messageThreadId,
            interaction,
          );
          return;
        }
        const blocked = correctGuard();
        if (blocked !== null) {
          const home = createInteraction('HOME');
          persistAll();
          await sendLabeled(blocked.text, homeKeyboard(home.id), interaction.messageThreadId, home);
          return;
        }
        deps.interactions.touch(interaction.id, { view: 'correct' });
        persistAll();
        await sendLabeled(
          CORRECTION_PROMPT_TEXT,
          draftKeyboard(interaction.id),
          interaction.messageThreadId,
          interaction,
        );
        return;
      }
      /**
       * Slice B sale buttons (additive): [🛒 Venta nueva] opens the
       * guided NewSale card on the same draft core the sale NL uses;
       * [⚠️ Usar emergencia] authorizes profile-5 EXPLICITLY, separate
       * from sale confirmation. Both travel owned (caller verified).
       */
      if (action === 'saleNew') {
        if (saleToolDeps === undefined) {
          await ackStale('saleNew');
          return;
        }
        // Explicit new intent over a substantive open draft: NO hybrid —
        // the SAME card shows GESTIÓN PENDIENTE and the old draft stays
        // byte-intact ([Continuar] resumes it, [Cancelar] drops it).
        const open = saleToolDeps.store.get(owner);
        if (open !== undefined && isSubstantiveSaleDraft(open)) {
          await runSalePendingFlow(interaction, interaction.messageThreadId);
          return;
        }
        await runSaleText('venta nueva', interaction.messageThreadId);
        return;
      }
      if (action === 'saleEmergency') {
        if (saleToolDeps === undefined || !hasOpenSaleDraft()) {
          await ackStale('saleEmergency');
          return;
        }
        await runSaleEmergencyFlow(interaction, interaction.messageThreadId);
        return;
      }
      /**
       * Foreground sale buttons (button≡NL): [Continuar venta]
       * re-renders the in-progress draft on the SAME card; the three
       * service/modality options fold the structured choice into the
       * SAME open draft (same core as the equivalent NL sentence).
       */
      if (action === 'saleKeep') {
        if (saleToolDeps === undefined || !hasOpenSaleDraft()) {
          await ackStale('saleKeep');
          return;
        }
        await runSaleResumeFlow(interaction, interaction.messageThreadId);
        return;
      }
      if (
        action === 'saleModNetflix' ||
        action === 'saleModFlujoShared' ||
        action === 'saleModFlujoComplete'
      ) {
        if (saleToolDeps === undefined || !hasOpenSaleDraft()) {
          await ackStale(action);
          return;
        }
        const choice =
          action === 'saleModNetflix'
            ? { service: 'netflix' as const, modality: 'netflix-profile' as const }
            : action === 'saleModFlujoShared'
              ? { service: 'flujotv' as const, modality: 'flujotv-shared' as const }
              : { service: 'flujotv' as const, modality: 'flujotv-complete' as const };
        await runSaleChoiceFlow(interaction, choice, interaction.messageThreadId);
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
        if (
          interaction.state['view'] === 'credentials-list' ||
          interaction.state['view'] === 'whatsapp-list'
        ) {
          await renderCredentialSelection(interaction, viewIndex);
          return;
        }
        if (interaction.state['view'] === 'whatsapp-phones') {
          await renderWhatsAppPhoneChoice(interaction, viewIndex);
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
      await sendLabeled(sectionText, sectionKeyboard(action, view.id), interaction.messageThreadId, view);
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
          await ackOwnedReceipt({
            text: crossActionText(
              deps.interactions.resolveOwnerLabelSync(
                targetChatId,
                interaction.ownerTelegramUserId,
                interaction.ownerName,
              ),
            ),
          });
          auditInteraction('interaction.blocked_cross_thread', interaction, {
            requestedAction: action,
            threadId: targetThreadId,
            expectedThreadId: interaction.messageThreadId,
          });
          return { ok: true };
        }
        // Ownership verified above (interaction → chat → owner →
        // thread, all sync and mutation-free).
        //
        // HOTFIX 2 stale-callback protection (SALE cards only — legacy
        // demo flows keep their approved idempotent-repeat behavior): a
        // tap on a NON-PENDING sale card (frozen terminal: the stored
        // operationId/sale view marks it sale-managed) is a safe no-op —
        // ack fast with the brief "gestión terminada" note, mutate
        // nothing, refresh nothing, resurrect nothing. The WhatsApp URL
        // button still works (it fires no callback at all). Stale taps
        // on an operation that is still current refresh the current card
        // instead (handled inside executeOwned via the operation gate).
        {
          const view = interaction.state['view'];
          const isSaleManaged =
            typeof interaction.state['operationId'] === 'string' ||
            (typeof view === 'string' && (view as string).startsWith('sale-'));
          if (interaction.status !== 'PENDING' && isSaleManaged) {
            await ackOwnedReceipt({ text: SALE_TERMINAL_STALE_TEXT });
            auditInteraction('interaction.stale_terminal', interaction, {
              requestedAction: action,
            });
            return { ok: true };
          }
        }
        if (interaction.type === 'OPERATION') {
          const gated = operationIdOf(interaction);
          if (gated !== undefined) {
            saleMetrics.record(gated, 'callback');
          }
        }
        // Ack the receipt FIRST, so
        // the spinner dies before any DB recompute, render, or edit.
        // Every renderer below ends in the idempotent ack as well, so
        // exactly one answer ever leaves per callback.
        await ackOwnedReceipt();
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
      if (action === 'services') {
        // Legacy unbound Servicios: no owned selector exists — Home.
        await respond(HOME_TEXT);
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
        if (saleToolDeps !== undefined && hasSaleDraft()) {
          await runSaleConfirmFlow(undefined);
          return { ok: true };
        }
        const result = await confirmWithActivity();
        await respondDraft(result.text, true);
        return { ok: true };
      }
      if (action === 'cancel') {
        if (saleToolDeps !== undefined && hasOpenSaleDraft()) {
          await runSaleCancelFlow(undefined);
          return { ok: true };
        }
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
      if (parse.kind === 'whatsapp') {
        // Direct WhatsApp delivery (L2, zero Gemini): the SAME delivery
        // tool the 💬 Abrir WhatsApp button prepares — button≡NL by
        // construction. Read-only: no confirmation, no draft.
        await runWhatsAppFlow(undefined, parse.service);
        return { ok: true };
      }
      if (parse.kind === 'credentials') {
        // Explicit datos request (L2, zero Gemini): the SAME
        // SHOW_CREDENTIALS tool the 🔐Datos button runs — button≡NL by
        // construction. Read-only: no confirmation, no draft.
        await runCredentialsFlow(undefined, parse.service);
        return { ok: true };
      }
      if (parse.kind === 'command') {
        if (parse.command === 'confirmar') {
          if (saleToolDeps !== undefined && hasSaleDraft()) {
            await runSaleConfirmFlow(undefined);
            return { ok: true };
          }
          const result = await confirmWithActivity();
          await respondDraft(result.text, true);
          return { ok: true };
        }
        if (parse.command === 'cancelar') {
          if (saleToolDeps !== undefined && hasOpenSaleDraft()) {
            await runSaleCancelFlow(undefined);
            return { ok: true };
          }
          const result = cancelWithIdempotency();
          await respondDraft(result.text, true);
          return { ok: true };
        }
        if (parse.command === 'volver') {
          // NL "volver" = Volver (pop the actor's own nav stack), never an
          // arbitrary Home. SEARCH and live-sale OPERATION contexts pop;
          // anything else (or a sale interaction with no open draft)
          // answers Home as the honest root reply.
          const active = deps.interactions.getActive(
            targetChatId,
            targetActorId,
            targetThreadId,
          );
          if (active !== undefined && active.type === 'SEARCH') {
            await handleBack(active);
            return { ok: true };
          }
          if (
            active !== undefined &&
            active.type === 'OPERATION' &&
            hasOpenSaleDraft()
          ) {
            await handleBack(active);
            return { ok: true };
          }
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
        // Slice B (additive): with an open sale draft the month text is
        // a sale correction on the SAME draft — never the generic demo.
        if (saleToolDeps !== undefined && hasOpenSaleDraft()) {
          await runSaleText(text);
          return { ok: true };
        }
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
      await respond(
        unknownHelpText('Se esperaba un teléfono, nombre o cuenta para buscar.'),
      );
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
      // L3 semantic/reference variant: an identifier stated verbatim in
      // the text travels explicitly (explicit current-message identifier
      // beats stored context); reference-only ('esa…') resolves from the
      // actor's own context inside the flow.
      const l3Identifier = pickSearchIdentifier(intent.params);
      if (intent.params['whatsapp'] === true) {
        // WhatsApp semantic variant (L3): same delivery tool as the L2
        // phrases and the 💬 Abrir WhatsApp button.
        await runWhatsAppFlow(undefined, serviceFilter, l3Identifier);
        return { ok: true };
      }
      await runCredentialsFlow(undefined, serviceFilter, l3Identifier);
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
          interaction,
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
        await respond(
          unknownHelpText(
            'Para crear una operación dilo explícito (ej. «crea una operación de prueba de 2 meses»).',
          ),
        );
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
      // Slice B (additive): sale corrections fold into the SAME sale
      // draft; otherwise the legacy generic draft correction.
      if (saleToolDeps !== undefined && hasOpenSaleDraft()) {
        await runSaleText(text);
        return { ok: true };
      }
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
    await respond(unknownHelpText());
    return { ok: true };
  };
}

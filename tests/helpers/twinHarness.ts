/**
 * Shared parameterized E2E harness (transversal, going-forward standard).
 *
 * ONE helper for every button↔NL twin test: phrase → layer → tool/spy +
 * Gemini-call counting. New E2E files MUST build their world with
 * `createTwinWorld` and drive it with `sendText`/`tapButton` instead of
 * hand-rolling Fastify injection, stub clients, and temp dirs (the
 * pre-harness duplication across ~47 files stays as-is — do NOT migrate
 * it in feature work).
 *
 * Contract asserted per twin:
 * - Button tap routes L1, NL phrase routes L2/L3 (via `route()`).
 * - Both converge on the SAME deterministic tool (spy on the repo/store
 *   method, or compare the final reply text).
 * - `geminiCalls` delta proves zero-Gemini where L1/L2 resolve and
 *   exactly-one-Gemini where L3 semantics are required.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'light-my-request';
import { StubIntentInterpreter } from '../../src/ai/intentInterpreter';
import { buildApp } from '../../src/app';
import { parseAuthorizedChatIds, parseAuthorizedIds } from '../../src/auth/allowlist';
import type { Env } from '../../src/config/env';
import { DraftEngine } from '../../src/drafts/engine';
import { InteractionStore } from '../../src/interactions/interactions';
import { MockStore } from '../../src/mock/mockStore';
import { MockAccountRepositories } from '../../src/mock/repositories';
import { route } from '../../src/router/hybrid';
import { NewSaleDraftStore } from '../../src/sale/newSaleDraft';
import { SessionStore } from '../../src/session/store';
import type { TelegramClient } from '../../src/telegram/client';

export const GABRIEL = 1057242322;
export const EDWARD = 941030473;
export const GROUP_CHAT_ID = -1005550001;

const NAMES: Record<number, string> = {
  [GABRIEL]: 'Gabriel',
  [EDWARD]: 'Edward',
};

export const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  TELEGRAM_BOT_TOKEN: 'tok-test-secret',
  TELEGRAM_WEBHOOK_SECRET: 'wh-test-secret-long-enough',
  AUTHORIZED_TELEGRAM_USER_IDS: `${GABRIEL},${EDWARD}`,
  AUTHORIZED_TELEGRAM_CHAT_IDS: `${GROUP_CHAT_ID}`,
  TELEGRAM_OPERATOR_TOPICS: '',
  TELEGRAM_ACTIVITY_TOPIC_ID: '',
  GEMINI_API_KEY: 'key-test-secret',
  GEMINI_MODEL: 'gemini-2.0-flash',
  PUBLIC_BASE_URL: 'https://example.com',
  REGISTER_TELEGRAM_WEBHOOK: 'false',
  MOCK_STATE_PATH: '/data/mock-state.json',
  DRAFTS_STATE_PATH: '/data/drafts-state.json',
  INTERACTIONS_STATE_PATH: '/data/interactions-state.json',
  OPERATOR_PROFILES_STATE_PATH: '/data/operator-profiles-state.json',
  SALE_DRAFTS_STATE_PATH: '/data/sale-drafts-state.json',
  CASH_HOLDERS: '',
};

type SendOpts = Parameters<TelegramClient['sendMessage']>[0];
type EditOpts = Parameters<TelegramClient['editMessageText']>[0];
type MarkupOpts = Parameters<NonNullable<TelegramClient['editMessageReplyMarkup']>>[0];

interface SentPayload {
  chatId: number;
  text: string;
  messageThreadId?: number;
  replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> };
}

/** Stub client with sent-message ids (adoption works), markup edits, and one-shot edit failures. */
export class StubTelegramClient implements TelegramClient {
  readonly sent: Array<{ kind: 'send' | 'edit' | 'markup' | 'answer'; payload: unknown }> = [];
  private nextMessageId = 100;
  /** When set, the next editMessageText throws it (card-lost simulation), then clears. */
  failNextEditWith: unknown = undefined;

  async sendMessage(opts: SendOpts): Promise<unknown> {
    this.nextMessageId += 1;
    this.sent.push({ kind: 'send', payload: opts });
    return { ok: true, result: { message_id: this.nextMessageId } };
  }

  async editMessageText(opts: EditOpts): Promise<unknown> {
    if (this.failNextEditWith !== undefined) {
      const failure = this.failNextEditWith;
      this.failNextEditWith = undefined;
      throw failure;
    }
    this.sent.push({ kind: 'edit', payload: opts });
    return { ok: true };
  }

  async editMessageReplyMarkup(opts: MarkupOpts): Promise<unknown> {
    this.sent.push({ kind: 'markup', payload: opts });
    return { ok: true };
  }

  async answerCallbackQuery(callbackQueryId: string, opts?: { text?: string }): Promise<unknown> {
    this.sent.push({ kind: 'answer', payload: { callbackQueryId, ...opts } });
    return { ok: true };
  }

  messages(): SentPayload[] {
    return this.sent
      .filter((entry) => entry.kind === 'send' || entry.kind === 'edit')
      .map((entry) => entry.payload as SentPayload);
  }

  texts(): string[] {
    return this.messages().map((entry) => entry.text);
  }

  markupEdits(): MarkupOpts[] {
    return this.sent
      .filter((entry) => entry.kind === 'markup')
      .map((entry) => entry.payload as MarkupOpts);
  }

  findButton(text: string): string | undefined {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      const entry = this.sent[index];
      if (entry === undefined || entry.kind === 'answer' || entry.kind === 'markup') {
        continue;
      }
      const payload = entry.payload as SentPayload;
      const flat = payload.replyMarkup?.inline_keyboard.flat() ?? [];
      const found = flat.find((button) => button.text === text);
      if (found?.callback_data !== undefined) {
        return found.callback_data;
      }
    }
    return undefined;
  }
}

export interface TwinWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter;
  drafts: DraftEngine;
  interactions: InteractionStore;
  repos: MockAccountRepositories;
  store: MockStore;
  saleDrafts?: NewSaleDraftStore;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<LightMyRequestResponse>;
}

export async function createTwinWorld(opts?: {
  topics?: Map<number, number>;
  sale?: boolean;
}): Promise<TwinWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-harness-'));
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const client = new StubTelegramClient();
  const interpreter = new StubIntentInterpreter();
  const drafts = new DraftEngine();
  const interactions = new InteractionStore();
  const repos = new MockAccountRepositories(store);
  const saleDrafts = opts?.sale === true ? new NewSaleDraftStore() : undefined;
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions: new SessionStore(),
    drafts,
    interactions,
    interpreter,
    repos,
    client,
    operatorTopics: opts?.topics ?? new Map(),
    ...(saleDrafts !== undefined ? { sale: { saleDrafts, mockStore: store } } : {}),
  });
  let counter = 9000;
  return {
    app,
    client,
    interpreter,
    drafts,
    interactions,
    repos,
    store,
    ...(saleDrafts !== undefined ? { saleDrafts } : {}),
    nextUpdateId: () => {
      counter += 1;
      return counter;
    },
    post: async (update: unknown) =>
      app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': testEnv.TELEGRAM_WEBHOOK_SECRET },
        payload: update,
      }),
  };
}

export function twinMessage(
  updateId: number,
  actorId: number,
  text: string,
  threadId?: number,
): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Operator' },
      chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
      text,
    },
  };
}

export function twinCallback(
  updateId: number,
  actorId: number,
  data: string,
  threadId?: number,
): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Operator' },
      message: {
        message_id: 7,
        chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      },
      data,
    },
  };
}

/** NL entry: one actor sentence. Returns the webhook response. */
export async function sendText(
  world: TwinWorld,
  actorId: number,
  text: string,
  threadId?: number,
): Promise<LightMyRequestResponse> {
  return world.post(twinMessage(world.nextUpdateId(), actorId, text, threadId));
}

/** Button entry: tap a callback payload directly. */
export async function tapCallback(
  world: TwinWorld,
  actorId: number,
  data: string,
  threadId?: number,
): Promise<LightMyRequestResponse> {
  return world.post(twinCallback(world.nextUpdateId(), actorId, data, threadId));
}

/** Home-button tap by visible label (opens /start, finds the button, taps it). */
export async function tapButton(
  world: TwinWorld,
  actorId: number,
  label: string,
): Promise<LightMyRequestResponse> {
  await sendText(world, actorId, '/start');
  const data = world.client.findButton(label);
  if (data === undefined) {
    throw new Error(`${label} button missing`);
  }
  return tapCallback(world, actorId, data);
}

/** Gemini-call count (StubIntentInterpreter.calls) — the counting half of every twin. */
export function geminiCalls(world: TwinWorld): number {
  return world.interpreter.calls;
}

/** Routing layer for one NL phrase (L2 proves zero-Gemini without posting). */
export async function phraseLayer(
  world: TwinWorld,
  actorId: number,
  text: string,
): Promise<string> {
  const decision = await route({ userId: actorId, chatId: GROUP_CHAT_ID, text }, world.interpreter);
  return decision.layer;
}

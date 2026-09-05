import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { StubIntentInterpreter } from '../src/ai/intentInterpreter';
import { createAuditor } from '../src/audit/audit';
import { parseAuthorizedChatIds, parseAuthorizedIds } from '../src/auth/allowlist';
import { buildApp } from '../src/app';
import type { Env } from '../src/config/env';
import { DraftEngine } from '../src/drafts/engine';
import { InteractionStore } from '../src/interactions/interactions';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';
import { callbackData, callbackDataFor } from '../src/telegram/keyboards';

/**
 * Origin-topic regression suite: EVERY reply must return to the topic
 * that produced its update. Same mock supergroup chat for all tests;
 * Gabriel lives in topic 101, Edward in 202. Business logic never
 * hardcodes these ids — they are test-only values.
 */
const GABRIEL = 1057242322;
const EDWARD = 941030473;
const GROUP_CHAT_ID = -1005550001;

const THREAD_GABRIEL = 101;
const THREAD_EDWARD = 202;

const TOPICS = new Map<number, number>([
  [GABRIEL, THREAD_GABRIEL],
  [EDWARD, THREAD_EDWARD],
]);

const testEnv: Env = {
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
};

interface SentPayload {
  chatId: number;
  text: string;
  replyMarkup?: unknown;
  messageThreadId?: number;
}

class StubTelegramClient implements TelegramClient {
  readonly sent: Array<{ kind: 'send' | 'edit' | 'answer'; payload: unknown }> = [];

  async sendMessage(opts: SentPayload): Promise<unknown> {
    this.sent.push({ kind: 'send', payload: opts });
    return { ok: true };
  }

  async editMessageText(opts: SentPayload & { messageId: number }): Promise<unknown> {
    this.sent.push({ kind: 'edit', payload: opts });
    return { ok: true };
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    opts?: { text?: string },
  ): Promise<unknown> {
    this.sent.push({
      kind: 'answer',
      payload: { callbackQueryId, ...(opts?.text !== undefined ? { text: opts.text } : {}) },
    });
    return { ok: true };
  }

  /** Fresh messages only — edits stay in place by definition. */
  freshSends(): SentPayload[] {
    return this.sent
      .filter((entry) => entry.kind === 'send')
      .map((entry) => entry.payload as SentPayload);
  }

  answers(): Array<{ callbackQueryId: string; text?: string }> {
    return this.sent
      .filter((entry) => entry.kind === 'answer')
      .map((entry) => entry.payload as { callbackQueryId: string; text?: string });
  }
}

interface ReplyWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  drafts: DraftEngine;
  interactions: InteractionStore;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<void>;
}

async function createReplyWorld(topics?: Map<number, number>): Promise<ReplyWorld> {
  const statePath = join(mkdtempSync(join(tmpdir(), 'vokath-replies-')), 'mock-state.json');
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath,
  });
  const client = new StubTelegramClient();
  const drafts = new DraftEngine();
  const interactions = new InteractionStore();
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions: new SessionStore(),
    drafts,
    interactions,
    interpreter: new StubIntentInterpreter(),
    repos: new MockAccountRepositories(store),
    client,
    auditor: createAuditor(),
    operatorTopics: topics ?? TOPICS,
  });
  let counter = 5000;
  return {
    app,
    client,
    drafts,
    interactions,
    nextUpdateId: () => {
      counter += 1;
      return counter;
    },
    post: async (update: unknown) => {
      await app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': testEnv.TELEGRAM_WEBHOOK_SECRET },
        payload: update,
      });
    },
  };
}

const NAMES: Record<number, string> = {
  [GABRIEL]: 'Gabriel',
  [EDWARD]: 'Edward',
};

function chatPart(isForum = false): Record<string, unknown> {
  return {
    id: GROUP_CHAT_ID,
    type: 'supergroup',
    ...(isForum ? { is_forum: true } : {}),
  };
}

function replyMessage(
  updateId: number,
  actorId: number,
  text: string,
  threadId?: number,
  extra?: { isForum?: boolean; replyToText?: string },
): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Stranger' },
      chat: chatPart(extra?.isForum ?? false),
      text,
      ...(extra?.replyToText !== undefined
        ? {
            reply_to_message: {
              message_id: 5,
              chat: chatPart(false),
              text: extra.replyToText,
            },
          }
        : {}),
    },
  };
}

function replyCallback(
  updateId: number,
  actorId: number,
  data: string,
  threadId?: number,
  opts?: { omitMessageId?: boolean },
): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Stranger' },
      message: {
        ...(opts?.omitMessageId === true ? {} : { message_id: 7 }),
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
        chat: chatPart(false),
      },
      data,
    },
  };
}

describe('origin-topic replies (forum root-cause fix)', () => {
  it('(1) /start in 101 replies with thread 101', async () => {
    const world = await createReplyWorld();
    await world.post(replyMessage(world.nextUpdateId(), GABRIEL, '/start', THREAD_GABRIEL));
    const last = world.client.freshSends().at(-1);
    expect(last?.text).toContain('Vokath');
    expect(last?.messageThreadId).toBe(THREAD_GABRIEL);
    await world.app.close();
  });

  it('(2) Buscar in 101 replies with thread 101', async () => {
    const world = await createReplyWorld();
    await world.post(replyMessage(world.nextUpdateId(), GABRIEL, 'netflix', THREAD_GABRIEL));
    const last = world.client.freshSends().at(-1);
    expect(last?.text).toContain('resultado(s) MOCK');
    expect(last?.messageThreadId).toBe(THREAD_GABRIEL);
    await world.app.close();
  });

  it('(3) Operar in 101 replies with thread 101', async () => {
    const world = await createReplyWorld();
    // Tap without an attached message id forces a FRESH message (no edit
    // target) — it must still return to the origin topic.
    await world.post(
      replyCallback(world.nextUpdateId(), GABRIEL, callbackData('operar'), THREAD_GABRIEL, {
        omitMessageId: true,
      }),
    );
    const last = world.client.freshSends().at(-1);
    expect(last?.text).toContain('Borrador');
    expect(last?.messageThreadId).toBe(THREAD_GABRIEL);
    await world.app.close();
  });

  it('(4) Gemini reply from 101 returns to 101', async () => {
    const world = await createReplyWorld();
    await world.post(
      replyMessage(world.nextUpdateId(), GABRIEL, 'cuéntame algo interesante', THREAD_GABRIEL),
    );
    const last = world.client.freshSends().at(-1);
    expect(last?.messageThreadId).toBe(THREAD_GABRIEL);
    await world.app.close();
  });

  it('(5) ownership error from 101 returns to 101', async () => {
    const world = await createReplyWorld(new Map());
    await world.post(replyMessage(world.nextUpdateId(), GABRIEL, 'netflix', THREAD_GABRIEL));
    const gabrielLabel = '🔎 3 resultado(s) MOCK:\n👤 Operador: Gabriel';
    await world.post(
      replyMessage(world.nextUpdateId(), EDWARD, 'hazlo 2 meses', THREAD_GABRIEL, {
        replyToText: gabrielLabel,
      }),
    );
    const last = world.client.freshSends().at(-1);
    expect(last?.text).toContain('pertenece a Gabriel');
    expect(last?.messageThreadId).toBe(THREAD_GABRIEL);
    await world.app.close();
  });

  it('(6) callback from a 101 message keeps 101 context', async () => {
    const world = await createReplyWorld();
    await world.post(
      replyCallback(world.nextUpdateId(), GABRIEL, callbackData('operar'), THREAD_GABRIEL),
    );
    const owned = world.interactions
      .snapshot()
      .find(
        (interaction) =>
          interaction.ownerTelegramUserId === GABRIEL && interaction.type === 'OPERATION',
      );
    expect(owned?.messageThreadId).toBe(THREAD_GABRIEL);
    // Owner confirms from his own 101 message: executes in context.
    await world.post(
      replyCallback(
        world.nextUpdateId(),
        GABRIEL,
        callbackDataFor('confirm', owned?.id ?? 'missing'),
        THREAD_GABRIEL,
      ),
    );
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe(
      'confirmed',
    );
    // Nothing produced by this flow escaped the origin topic.
    for (const send of world.client.freshSends()) {
      expect(send.messageThreadId).toBe(THREAD_GABRIEL);
    }
    await world.app.close();
  });

  it('(7) Edward in 202 replies with thread 202', async () => {
    const world = await createReplyWorld();
    await world.post(replyMessage(world.nextUpdateId(), EDWARD, '/start', THREAD_EDWARD));
    const last = world.client.freshSends().at(-1);
    expect(last?.text).toContain('Vokath');
    expect(last?.messageThreadId).toBe(THREAD_EDWARD);
    await world.app.close();
  });

  it('(8) a 101 reply NEVER goes to 202', async () => {
    const world = await createReplyWorld();
    await world.post(replyMessage(world.nextUpdateId(), GABRIEL, 'netflix', THREAD_GABRIEL));
    const last = world.client.freshSends().at(-1);
    expect(last?.messageThreadId).toBe(THREAD_GABRIEL);
    expect(last?.messageThreadId).not.toBe(THREAD_EDWARD);
    await world.app.close();
  });

  it('(9) a topic reply NEVER falls back to General by losing threadId', async () => {
    const world = await createReplyWorld();
    await world.post(replyMessage(world.nextUpdateId(), GABRIEL, '/start', THREAD_GABRIEL));
    await world.post(replyMessage(world.nextUpdateId(), GABRIEL, 'netflix', THREAD_GABRIEL));
    const fresh = world.client.freshSends();
    expect(fresh.length).toBeGreaterThan(0);
    for (const send of fresh) {
      expect(send.messageThreadId).toBe(THREAD_GABRIEL);
    }
    await world.app.close();
  });

  it('(10) General still works (no thread, no mapping)', async () => {
    const world = await createReplyWorld(new Map());
    await world.post(replyMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const last = world.client.freshSends().at(-1);
    expect(last?.text).toContain('Vokath');
    expect(last?.messageThreadId).toBeUndefined();
    await world.app.close();
  });

  it('(11) supergroup with is_forum true is accepted in 101', async () => {
    const world = await createReplyWorld();
    await world.post(
      replyMessage(world.nextUpdateId(), GABRIEL, 'netflix', THREAD_GABRIEL, { isForum: true }),
    );
    const last = world.client.freshSends().at(-1);
    expect(last?.text).toContain('resultado(s) MOCK');
    expect(last?.messageThreadId).toBe(THREAD_GABRIEL);
    await world.app.close();
  });

  it('(12) ownership intact: cross-actor tap rejected with threads', async () => {
    const world = await createReplyWorld();
    await world.post(
      replyCallback(world.nextUpdateId(), GABRIEL, callbackData('operar'), THREAD_GABRIEL),
    );
    const owned = world.interactions
      .snapshot()
      .find(
        (interaction) =>
          interaction.ownerTelegramUserId === GABRIEL && interaction.type === 'OPERATION',
      );
    expect(owned).toBeDefined();
    // Edward taps Gabriel's button from his own topic: rejected, executes nothing.
    await world.post(
      replyCallback(
        world.nextUpdateId(),
        EDWARD,
        callbackDataFor('confirm', owned?.id ?? 'missing'),
        THREAD_EDWARD,
      ),
    );
    const toast = world.client.answers().at(-1);
    expect(toast?.text).toContain('Gabriel');
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })).toBeUndefined();
    await world.app.close();
  });
});

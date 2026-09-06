import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  StubIntentInterpreter,
  type Intent,
  type SessionCtx,
} from '../src/ai/intentInterpreter';
import { createAuditor, type AuditEvent } from '../src/audit/audit';
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
import { parseOperatorTopics } from '../src/telegram/topics';

/**
 * Forum Topics mode suite (Mode B additive on top of the shared group).
 *
 * Actor/thread ids here are TEST-ONLY values. Business logic never
 * hardcodes them; production reads TELEGRAM_OPERATOR_TOPICS from env.
 */
const GABRIEL = 1057242322;
const EDWARD = 941030473;
const OP3 = 313131313;
const GROUP_CHAT_ID = -1005550001;

const THREAD_GABRIEL = 101;
const THREAD_EDWARD = 202;
const THREAD_OP3 = 303;
const ACTIVITY_THREAD = 404;

const TOPICS = new Map<number, number>([
  [GABRIEL, THREAD_GABRIEL],
  [EDWARD, THREAD_EDWARD],
  [OP3, THREAD_OP3],
]);

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  TELEGRAM_BOT_TOKEN: 'tok-test-secret',
  TELEGRAM_WEBHOOK_SECRET: 'wh-test-secret-long-enough',
  AUTHORIZED_TELEGRAM_USER_IDS: `${GABRIEL},${EDWARD},${OP3}`,
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

  async editMessageText(
    opts: SentPayload & { messageId: number },
  ): Promise<unknown> {
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

  sends(): SentPayload[] {
    return this.sent
      .filter((entry) => entry.kind === 'send' || entry.kind === 'edit')
      .map((entry) => entry.payload as SentPayload);
  }

  texts(): string[] {
    return this.sends().map((entry) => entry.text);
  }

  answers(): Array<{ callbackQueryId: string; text?: string }> {
    return this.sent
      .filter((entry) => entry.kind === 'answer')
      .map((entry) => entry.payload as { callbackQueryId: string; text?: string });
  }
}

/** Recording interpreter: proves which actor context reached Gemini. */
class RecordingInterpreter extends StubIntentInterpreter {
  lastCtx: SessionCtx | undefined;

  override async interpret(text: string, ctx: SessionCtx): Promise<Intent> {
    this.lastCtx = { ...ctx };
    return super.interpret(text, ctx);
  }
}

interface TopicWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: RecordingInterpreter;
  sessions: SessionStore;
  drafts: DraftEngine;
  interactions: InteractionStore;
  auditEvents: AuditEvent[];
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

async function createTopicWorld(opts?: {
  topics?: Map<number, number>;
  activityTopicId?: number;
}): Promise<TopicWorld> {
  const statePath = join(mkdtempSync(join(tmpdir(), 'vokath-topics-')), 'mock-state.json');
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath,
  });
  const client = new StubTelegramClient();
  const interpreter = new RecordingInterpreter();
  const sessions = new SessionStore();
  const drafts = new DraftEngine();
  const interactions = new InteractionStore();
  const auditEvents: AuditEvent[] = [];
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions,
    drafts,
    interactions,
    interpreter,
    repos: new MockAccountRepositories(store),
    client,
    auditor: createAuditor((event) => {
      auditEvents.push(event);
    }),
    ...(opts?.topics !== undefined
      ? { operatorTopics: opts.topics }
      : { operatorTopics: TOPICS }),
    ...(opts?.activityTopicId !== undefined
      ? { activityTopicId: opts.activityTopicId }
      : {}),
  });
  let counter = 9000;
  return {
    app,
    client,
    interpreter,
    sessions,
    drafts,
    interactions,
    auditEvents,
    nextUpdateId: () => {
      counter += 1;
      return counter;
    },
    post: async (update: unknown) => {
      const response = await app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': testEnv.TELEGRAM_WEBHOOK_SECRET },
        payload: update,
      });
      return { status: response.statusCode, body: response.json() as unknown };
    },
  };
}

const NAMES: Record<number, string> = {
  [GABRIEL]: 'Gabriel',
  [EDWARD]: 'Edward',
  [OP3]: 'Marta',
};

interface FromOverride {
  first_name?: string;
  last_name?: string;
  username?: string;
}

function topicMessage(
  updateId: number,
  actorId: number,
  text: string,
  threadId?: number,
  from?: FromOverride,
): unknown {
  const name = NAMES[actorId] ?? 'Stranger';
  const fromPart =
    from !== undefined
      ? { id: actorId, ...from }
      : { id: actorId, first_name: name };
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      from: fromPart,
      chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
      text,
    },
  };
}

function topicCallback(
  updateId: number,
  actorId: number,
  data: string,
  threadId?: number,
): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Stranger' },
      message: {
        message_id: 7,
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
        chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
      },
      data,
    },
  };
}

function draftOf(world: TopicWorld, userId: number) {
  return world.drafts.get({ chatId: GROUP_CHAT_ID, userId });
}

describe('forum Topics mode (Mode B)', () => {
  it('(1) Gabriel in his own thread is allowed', async () => {
    const world = await createTopicWorld();
    await world.post(topicMessage(world.nextUpdateId(), GABRIEL, 'netflix', THREAD_GABRIEL));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Gabriel');
    const last = world.client.sends().at(-1);
    expect(last?.messageThreadId).toBe(THREAD_GABRIEL);
    expect(world.sessions.getSession(GABRIEL, GROUP_CHAT_ID)?.userId).toBe(GABRIEL);
    await world.app.close();
  });

  it('(2) Edward in his own thread is allowed', async () => {
    const world = await createTopicWorld();
    await world.post(topicMessage(world.nextUpdateId(), EDWARD, '4145460657', THREAD_EDWARD));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('Anny Tovar');
    expect(world.client.sends().at(-1)?.messageThreadId).toBe(THREAD_EDWARD);
    await world.app.close();
  });

  it('(3) Operador3 in her own thread is allowed', async () => {
    const world = await createTopicWorld();
    await world.post(topicMessage(world.nextUpdateId(), OP3, 'netflix', THREAD_OP3));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    expect(world.client.sends().at(-1)?.messageThreadId).toBe(THREAD_OP3);
    await world.app.close();
  });

  it('(4) Edward writing in Gabriel thread is rejected with zero side-effects', async () => {
    const world = await createTopicWorld();
    // Setup so Gabriel's display name is known for the rejection text.
    await world.post(topicMessage(world.nextUpdateId(), GABRIEL, 'netflix', THREAD_GABRIEL));
    const before = world.interactions.snapshot().length;
    await world.post(topicMessage(world.nextUpdateId(), EDWARD, 'netflix', THREAD_GABRIEL));
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Gabriel. Usa tu topic 👤 Edward.',
    );
    expect(world.interpreter.calls).toBe(0);
    expect(world.sessions.getSession(EDWARD, GROUP_CHAT_ID)).toBeUndefined();
    expect(draftOf(world, EDWARD)).toBeUndefined();
    expect(world.interactions.snapshot().length).toBe(before);
    expect(
      world.auditEvents.some((event) => event.actionType === 'topic.blocked_cross_thread'),
    ).toBe(true);
    await world.app.close();
  });

  it('(5) Gabriel writing in Edward thread is rejected with zero side-effects', async () => {
    const world = await createTopicWorld();
    await world.post(topicMessage(world.nextUpdateId(), EDWARD, 'netflix', THREAD_EDWARD));
    const before = world.interactions.snapshot().length;
    await world.post(topicMessage(world.nextUpdateId(), GABRIEL, 'netflix', THREAD_EDWARD));
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Edward. Usa tu topic 👤 Gabriel.',
    );
    expect(world.interpreter.calls).toBe(0);
    expect(draftOf(world, GABRIEL)).toBeUndefined();
    expect(world.interactions.snapshot().length).toBe(before);
    await world.app.close();
  });

  it('(6) Operador3 writing in Gabriel thread is rejected', async () => {
    const world = await createTopicWorld();
    await world.post(topicMessage(world.nextUpdateId(), GABRIEL, 'netflix', THREAD_GABRIEL));
    await world.post(topicMessage(world.nextUpdateId(), OP3, 'netflix', THREAD_GABRIEL));
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Gabriel. Usa tu topic 👤 Marta.',
    );
    expect(world.interpreter.calls).toBe(0);
    expect(draftOf(world, OP3)).toBeUndefined();
    await world.app.close();
  });

  it('(7) callbacks keep owner + thread', async () => {
    const world = await createTopicWorld();
    await world.post(topicCallback(world.nextUpdateId(), GABRIEL, callbackData('operar'), THREAD_GABRIEL));
    expect(draftOf(world, GABRIEL)?.status).toBe('open');
    const owned = world.interactions
      .snapshot()
      .find(
        (interaction) =>
          interaction.ownerTelegramUserId === GABRIEL && interaction.type === 'OPERATION',
      );
    expect(owned?.messageThreadId).toBe(THREAD_GABRIEL);
    // Peer taps the same button from his own thread: owner check rejects.
    await world.post(
      topicCallback(
        world.nextUpdateId(),
        EDWARD,
        callbackDataFor('confirm', owned?.id ?? 'missing'),
        THREAD_EDWARD,
      ),
    );
    expect(world.client.answers().at(-1)?.text).toContain('Gabriel');
    expect(draftOf(world, GABRIEL)?.status).toBe('open');
    expect(draftOf(world, EDWARD)).toBeUndefined();
    // Stale thread on the interaction itself: owner matches, thread does
    // not — the cross-thread branch rejects without mutating.
    const stale = world.interactions.create(GROUP_CHAT_ID, GABRIEL, 'OPERATION', {
      ownerName: 'Gabriel',
      messageThreadId: 999,
    });
    await world.post(
      topicCallback(world.nextUpdateId(), GABRIEL, callbackDataFor('confirm', stale.id), THREAD_GABRIEL),
    );
    expect(
      world.auditEvents.some(
        (event) => event.actionType === 'interaction.blocked_cross_thread',
      ),
    ).toBe(true);
    expect(draftOf(world, GABRIEL)?.status).toBe('open');
    // Control: the owner tapping his own button in the right thread works.
    await world.post(
      topicCallback(
        world.nextUpdateId(),
        GABRIEL,
        callbackDataFor('confirm', owned?.id ?? 'missing'),
        THREAD_GABRIEL,
      ),
    );
    expect(draftOf(world, GABRIEL)?.status).toBe('confirmed');
    await world.app.close();
  });

  it('(8) text corrections never cross threads', async () => {
    const world = await createTopicWorld();
    await world.post(topicCallback(world.nextUpdateId(), GABRIEL, callbackData('operar'), THREAD_GABRIEL));
    await world.post(topicMessage(world.nextUpdateId(), GABRIEL, 'hazlo 3 meses', THREAD_GABRIEL));
    expect(draftOf(world, GABRIEL)?.months).toBe(3);
    // Edward corrects from his own thread: his own (missing) draft answers,
    // Gabriel's draft is untouched.
    await world.post(topicMessage(world.nextUpdateId(), EDWARD, 'hazlo 9 meses', THREAD_EDWARD));
    expect(world.client.texts().at(-1)).toContain('No hay borrador abierto');
    expect(draftOf(world, GABRIEL)?.months).toBe(3);
    expect(draftOf(world, EDWARD)).toBeUndefined();
    await world.app.close();
  });

  it('(9) drafts never cross threads', async () => {
    const world = await createTopicWorld();
    await world.post(topicCallback(world.nextUpdateId(), GABRIEL, callbackData('operar'), THREAD_GABRIEL));
    await world.post(topicCallback(world.nextUpdateId(), EDWARD, callbackData('operar'), THREAD_EDWARD));
    expect(draftOf(world, GABRIEL)?.status).toBe('open');
    expect(draftOf(world, EDWARD)?.status).toBe('open');
    await world.post(topicCallback(world.nextUpdateId(), EDWARD, callbackData('confirm'), THREAD_EDWARD));
    expect(draftOf(world, EDWARD)?.status).toBe('confirmed');
    expect(draftOf(world, GABRIEL)?.status).toBe('open');
    await world.app.close();
  });

  it('(10) search never crosses threads', async () => {
    const world = await createTopicWorld();
    await world.post(topicMessage(world.nextUpdateId(), GABRIEL, 'netflix', THREAD_GABRIEL));
    await world.post(topicMessage(world.nextUpdateId(), EDWARD, 'netflix', THREAD_EDWARD));
    const gabrielSearch = world.interactions
      .snapshot()
      .find(
        (interaction) =>
          interaction.ownerTelegramUserId === GABRIEL && interaction.type === 'SEARCH',
      );
    const edwardSearch = world.interactions
      .snapshot()
      .find(
        (interaction) =>
          interaction.ownerTelegramUserId === EDWARD && interaction.type === 'SEARCH',
      );
    expect(gabrielSearch?.messageThreadId).toBe(THREAD_GABRIEL);
    expect(edwardSearch?.messageThreadId).toBe(THREAD_EDWARD);
    // Edward taps Gabriel's result button from his own thread: rejected,
    // Gabriel's search state is untouched.
    const before = JSON.stringify(gabrielSearch);
    await world.post(
      topicCallback(
        world.nextUpdateId(),
        EDWARD,
        callbackDataFor('view0', gabrielSearch?.id ?? 'missing'),
        THREAD_EDWARD,
      ),
    );
    expect(world.client.answers().at(-1)?.text).toContain('Gabriel');
    expect(JSON.stringify(world.interactions.get(gabrielSearch?.id ?? 'missing'))).toBe(before);
    await world.app.close();
  });

  it('(11) Gemini context carries only the acting operator + thread', async () => {
    const world = await createTopicWorld();
    await world.post(
      topicMessage(world.nextUpdateId(), EDWARD, 'quiero buscar un cliente', THREAD_EDWARD),
    );
    expect(world.interpreter.calls).toBe(1);
    expect(world.interpreter.lastCtx?.userId).toBe(EDWARD);
    expect(world.interpreter.lastCtx?.chatId).toBe(GROUP_CHAT_ID);
    expect(world.interpreter.lastCtx?.messageThreadId).toBe(THREAD_EDWARD);
    expect(world.interpreter.lastCtx?.ownerName).toBe('Edward');
    expect(JSON.stringify(world.interpreter.lastCtx)).not.toContain('Gabriel');
    expect(JSON.stringify(world.interpreter.lastCtx)).not.toContain(String(THREAD_GABRIEL));
    // The L3 reply creates an Edward-owned interaction in Edward's thread.
    const created = world.interactions.snapshot().at(-1);
    expect(created?.ownerTelegramUserId).toBe(EDWARD);
    expect(created?.messageThreadId).toBe(THREAD_EDWARD);
    await world.app.close();
  });

  it('(12) no-mapping mode keeps current behavior (Mode A)', async () => {
    const world = await createTopicWorld({ topics: new Map() });
    await world.post(topicMessage(world.nextUpdateId(), GABRIEL, 'netflix', THREAD_GABRIEL));
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    // Cross-thread writes are NOT gated without a mapping.
    await world.post(topicMessage(world.nextUpdateId(), EDWARD, 'netflix', THREAD_GABRIEL));
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    expect(world.interpreter.calls).toBe(0);
    // Messages without any thread keep working too.
    await world.post(topicMessage(world.nextUpdateId(), GABRIEL, '/start'));
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Gabriel');
    await world.app.close();
  });

  it('(13) display name never renders empty', async () => {
    const world = await createTopicWorld();
    await world.post(
      topicMessage(world.nextUpdateId(), OP3, '/start', THREAD_OP3, {}),
    );
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('👤 Operador: Usuario');
    expect(last).not.toContain(String(OP3));
    for (const text of world.client.texts()) {
      expect(text).not.toMatch(/👤 Operador:\s*$/m);
    }
    await world.app.close();
  });

  it('(14) Telegram first_name (+last_name) resolves with no alias', async () => {
    const world = await createTopicWorld();
    await world.post(
      topicMessage(world.nextUpdateId(), GABRIEL, '/start', THREAD_GABRIEL, {
        first_name: 'Gabriel',
        last_name: 'Ruiz',
      }),
    );
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Gabriel Ruiz');
    await world.app.close();
  });

  it('(15) activity topic receives only the allowed event', async () => {
    const world = await createTopicWorld({ activityTopicId: ACTIVITY_THREAD });
    await world.post(topicMessage(world.nextUpdateId(), GABRIEL, '/start', THREAD_GABRIEL));
    await world.post(topicMessage(world.nextUpdateId(), GABRIEL, 'netflix', THREAD_GABRIEL));
    await world.post(topicCallback(world.nextUpdateId(), GABRIEL, callbackData('operar'), THREAD_GABRIEL));
    await world.post(topicCallback(world.nextUpdateId(), GABRIEL, callbackData('confirm'), THREAD_GABRIEL));
    await world.post(topicMessage(world.nextUpdateId(), GABRIEL, 'netflix', THREAD_GABRIEL));
    const activitySends = world.client.sends().filter(
      (send) => send.messageThreadId === ACTIVITY_THREAD,
    );
    expect(activitySends.length).toBe(1);
    expect(activitySends[0]?.text).toContain('✅ Operación confirmada');
    expect(activitySends[0]?.chatId).toBe(GROUP_CHAT_ID);
    expect(
      world.auditEvents.some((event) => event.actionType === 'activity.published'),
    ).toBe(true);
    await world.app.close();
  });

  it('(16) activity event contains no secrets', async () => {
    const world = await createTopicWorld({ activityTopicId: ACTIVITY_THREAD });
    await world.post(topicCallback(world.nextUpdateId(), GABRIEL, callbackData('operar'), THREAD_GABRIEL));
    await world.post(topicMessage(world.nextUpdateId(), GABRIEL, 'hazlo 3 meses', THREAD_GABRIEL));
    await world.post(topicCallback(world.nextUpdateId(), GABRIEL, callbackData('confirm'), THREAD_GABRIEL));
    const activity = world.client.sends().find(
      (send) => send.messageThreadId === ACTIVITY_THREAD,
    );
    expect(activity?.text).toContain('Gabriel');
    expect(activity?.text).toContain('3 mes(es)');
    expect(activity?.text).not.toMatch(/contrase|password|pin\b|token|secret|clave/i);
    expect(JSON.stringify(world.auditEvents)).not.toMatch(/contrase|password/i);
    await world.app.close();
  });
});

describe('operator topic parsing (fail-fast)', () => {
  it('parses a valid mapping and empty as Mode A', () => {
    expect(parseOperatorTopics(undefined).size).toBe(0);
    expect(parseOperatorTopics('').size).toBe(0);
    const parsed = parseOperatorTopics(`${GABRIEL}:${THREAD_GABRIEL},${EDWARD}:${THREAD_EDWARD}`);
    expect(parsed.get(GABRIEL)).toBe(THREAD_GABRIEL);
    expect(parsed.get(EDWARD)).toBe(THREAD_EDWARD);
  });

  it('throws on malformed entries', () => {
    expect(() => parseOperatorTopics('not-a-mapping')).toThrow();
    expect(() => parseOperatorTopics(`${GABRIEL}:0`)).toThrow();
    expect(() => parseOperatorTopics(`0:${THREAD_GABRIEL}`)).toThrow();
    expect(() => parseOperatorTopics(`${GABRIEL}:${THREAD_GABRIEL},${GABRIEL}:${THREAD_EDWARD}`)).toThrow();
  });
});

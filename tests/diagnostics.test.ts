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
import { loadEnv } from '../src/config/env';
import { parseAlertsTopicId } from '../src/telegram/topics';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Diagnostic commands suite (/topicid, /testalert).
 *
 * Actor ids here are TEST-ONLY values. Business logic never hardcodes
 * them; Andres (third operator) is invented for these tests only.
 */
const GABRIEL = 1057242322;
const EDWARD = 941030473;
const ANDRES = 555666777;
const GROUP_CHAT_ID = -1005550001;

const THREAD_GABRIEL = 101;
const THREAD_EDWARD = 202;
const THREAD_ANDRES = 303;
const ALERTS_THREAD = 505;

const SECRET = 'diag-test-secret-long-enough';

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  TELEGRAM_BOT_TOKEN: 'tok-test-secret',
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  AUTHORIZED_TELEGRAM_USER_IDS: `${GABRIEL},${EDWARD},${ANDRES}`,
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

  sends(): SentPayload[] {
    return this.sent
      .filter((entry) => entry.kind === 'send' || entry.kind === 'edit')
      .map((entry) => entry.payload as SentPayload);
  }
}

interface DiagWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter;
  sessions: SessionStore;
  drafts: DraftEngine;
  interactions: InteractionStore;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

async function createDiagWorld(opts?: { alertsTopicId?: number }): Promise<DiagWorld> {
  const statePath = join(mkdtempSync(join(tmpdir(), 'vokath-diag-')), 'mock-state.json');
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath,
  });
  const client = new StubTelegramClient();
  const interpreter = new StubIntentInterpreter();
  const sessions = new SessionStore();
  const drafts = new DraftEngine();
  const interactions = new InteractionStore();
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions,
    drafts,
    interactions,
    interpreter,
    repos: new MockAccountRepositories(store),
    client,
    auditor: createAuditor(),
    operatorTopics: new Map(),
    ...(opts?.alertsTopicId !== undefined ? { alertsTopicId: opts.alertsTopicId } : {}),
  });
  let counter = 7000;
  return {
    app,
    client,
    interpreter,
    sessions,
    drafts,
    interactions,
    nextUpdateId: () => {
      counter += 1;
      return counter;
    },
    post: async (update: unknown) => {
      const response = await app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': SECRET },
        payload: update,
      });
      return { status: response.statusCode, body: response.json() as unknown };
    },
  };
}

const NAMES: Record<number, string> = {
  [GABRIEL]: 'Gabriel',
  [EDWARD]: 'Edward',
  [ANDRES]: 'Andres',
};

function diagMessage(
  updateId: number,
  actorId: number,
  text: string,
  threadId?: number,
): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Stranger' },
      chat: { id: GROUP_CHAT_ID, type: 'supergroup', is_forum: true },
      text,
    },
  };
}

describe('/topicid diagnostics', () => {
  it('1. answers in thread 101 when run inside thread 101', async () => {
    const world = await createDiagWorld({ alertsTopicId: ALERTS_THREAD });
    const { status } = await world.post(
      diagMessage(world.nextUpdateId(), GABRIEL, '/topicid', THREAD_GABRIEL),
    );
    expect(status).toBe(200);
    expect(world.client.sends()).toHaveLength(1);
    expect(world.client.sends()[0]?.messageThreadId).toBe(THREAD_GABRIEL);
  });

  it('2. reports the real Thread ID 101', async () => {
    const world = await createDiagWorld({ alertsTopicId: ALERTS_THREAD });
    await world.post(diagMessage(world.nextUpdateId(), GABRIEL, '/topicid', THREAD_GABRIEL));
    expect(world.client.sends()[0]?.text).toContain('Thread ID: 101');
  });

  it('3. creates no draft', async () => {
    const world = await createDiagWorld({ alertsTopicId: ALERTS_THREAD });
    await world.post(diagMessage(world.nextUpdateId(), GABRIEL, '/topicid', THREAD_GABRIEL));
    expect(world.drafts.snapshot()).toHaveLength(0);
  });

  it('4. leaves the active session untouched', async () => {
    const world = await createDiagWorld({ alertsTopicId: ALERTS_THREAD });
    await world.post(diagMessage(world.nextUpdateId(), GABRIEL, '/topicid', THREAD_GABRIEL));
    expect(world.sessions.getSession(GABRIEL)).toBeUndefined();
    expect(world.sessions.getSession(GABRIEL, GROUP_CHAT_ID)).toBeUndefined();
    expect(world.interactions.snapshot()).toHaveLength(0);
  });

  it('5. never calls Gemini', async () => {
    const world = await createDiagWorld({ alertsTopicId: ALERTS_THREAD });
    await world.post(diagMessage(world.nextUpdateId(), GABRIEL, '/topicid', THREAD_GABRIEL));
    expect(world.interpreter.calls).toBe(0);
  });

  it('6. handles General (no thread) with a general/none Thread ID', async () => {
    const world = await createDiagWorld({ alertsTopicId: ALERTS_THREAD });
    await world.post(diagMessage(world.nextUpdateId(), GABRIEL, '/topicid'));
    const send = world.client.sends()[0];
    expect(send?.messageThreadId).toBeUndefined();
    expect(send?.text).toContain('General');
    expect(send?.text).toContain('general / none');
  });
});

describe('/testalert routing', () => {
  it('7. sends Gabriel’s alert to TELEGRAM_ALERTS_TOPIC_ID', async () => {
    const world = await createDiagWorld({ alertsTopicId: ALERTS_THREAD });
    await world.post(
      diagMessage(world.nextUpdateId(), GABRIEL, '/testalert', THREAD_GABRIEL),
    );
    const alert = world.client
      .sends()
      .find((entry) => entry.text.includes('ALERTA DE PRUEBA'));
    expect(alert?.messageThreadId).toBe(ALERTS_THREAD);
    expect(alert?.text).toContain('👤 Operador: Gabriel');
  });

  it('8. sends Edward’s alert to the same alerts topic', async () => {
    const world = await createDiagWorld({ alertsTopicId: ALERTS_THREAD });
    await world.post(diagMessage(world.nextUpdateId(), EDWARD, '/testalert', THREAD_EDWARD));
    const alert = world.client
      .sends()
      .find((entry) => entry.text.includes('ALERTA DE PRUEBA'));
    expect(alert?.messageThreadId).toBe(ALERTS_THREAD);
    expect(alert?.text).toContain('👤 Operador: Edward');
  });

  it('9. sends Andres’s alert to the same alerts topic', async () => {
    const world = await createDiagWorld({ alertsTopicId: ALERTS_THREAD });
    await world.post(diagMessage(world.nextUpdateId(), ANDRES, '/testalert', THREAD_ANDRES));
    const alert = world.client
      .sends()
      .find((entry) => entry.text.includes('ALERTA DE PRUEBA'));
    expect(alert?.messageThreadId).toBe(ALERTS_THREAD);
    expect(alert?.text).toContain('👤 Operador: Andres');
  });

  it('10. never drops the alert in General', async () => {
    const world = await createDiagWorld({ alertsTopicId: ALERTS_THREAD });
    await world.post(
      diagMessage(world.nextUpdateId(), GABRIEL, '/testalert', THREAD_GABRIEL),
    );
    for (const send of world.client.sends()) {
      expect(send.messageThreadId).toBeDefined();
    }
  });

  it('11. never drops the alert in the operator topic', async () => {
    const world = await createDiagWorld({ alertsTopicId: ALERTS_THREAD });
    await world.post(
      diagMessage(world.nextUpdateId(), GABRIEL, '/testalert', THREAD_GABRIEL),
    );
    const alert = world.client
      .sends()
      .find((entry) => entry.text.includes('ALERTA DE PRUEBA'));
    expect(alert?.messageThreadId).not.toBe(THREAD_GABRIEL);
  });

  it('12. confirms back in the operator’s own topic', async () => {
    const world = await createDiagWorld({ alertsTopicId: ALERTS_THREAD });
    await world.post(
      diagMessage(world.nextUpdateId(), GABRIEL, '/testalert', THREAD_GABRIEL),
    );
    const confirm = world.client
      .sends()
      .find((entry) => entry.text.includes('Alerta de prueba enviada'));
    expect(confirm?.messageThreadId).toBe(THREAD_GABRIEL);
  });

  it('16. leaks no secrets into the alert message', async () => {
    const world = await createDiagWorld({ alertsTopicId: ALERTS_THREAD });
    await world.post(
      diagMessage(world.nextUpdateId(), GABRIEL, '/testalert', THREAD_GABRIEL),
    );
    const alert = world.client
      .sends()
      .find((entry) => entry.text.includes('ALERTA DE PRUEBA'));
    expect(alert?.text).not.toContain('tok-test-secret');
    expect(alert?.text).not.toContain(SECRET);
    expect(alert?.text).not.toContain('key-test-secret');
  });
});

describe('alerts topic absent', () => {
  it('13. missing TELEGRAM_ALERTS_TOPIC_ID keeps startup working', async () => {
    const env = loadEnv({ ...testEnv, TELEGRAM_ALERTS_TOPIC_ID: undefined });
    expect(env.TELEGRAM_ALERTS_TOPIC_ID).toBeUndefined();
    expect(parseAlertsTopicId(undefined)).toBeUndefined();
    await createDiagWorld();
  });

  it('14. missing topic keeps /health working and /testalert graceful', async () => {
    const world = await createDiagWorld();
    const health = await world.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    const { status } = await world.post(
      diagMessage(world.nextUpdateId(), GABRIEL, '/testalert', THREAD_GABRIEL),
    );
    expect(status).toBe(200);
    expect(
      world.client.sends().some((entry) => entry.text.includes('ALERTA DE PRUEBA')),
    ).toBe(false);
  });

  it('malformed TELEGRAM_ALERTS_TOPIC_ID fails fast', () => {
    expect(() =>
      loadEnv({ ...testEnv, TELEGRAM_ALERTS_TOPIC_ID: 'nope' }),
    ).toThrow();
  });
});

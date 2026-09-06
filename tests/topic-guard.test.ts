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
import { AlertService } from '../src/alerts/alerts';
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
 * Central topic-ownership guard suite (Mode B root fix).
 *
 * Actor/thread ids here are TEST-ONLY values. Business logic never
 * hardcodes them; production reads TELEGRAM_OPERATOR_TOPICS from env.
 * Same mock GROUP_CHAT_ID as the rest of the suite.
 */
const GABRIEL = 1057242322;
const EDWARD = 941030473;
const ANDRES = 555666777;
const GROUP_CHAT_ID = -1005550001;

const T_GABRIEL = 18;
const T_EDWARD = 19;
const T_ANDRES = 24;
const T_ALERTS = 25;

const SECRET = 'guard-test-secret-long-enough';

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

  texts(): string[] {
    return this.sends().map((entry) => entry.text);
  }

  answers(): Array<{ callbackQueryId: string; text?: string }> {
    return this.sent
      .filter((entry) => entry.kind === 'answer')
      .map((entry) => entry.payload as { callbackQueryId: string; text?: string });
  }

  alertSends(): SentPayload[] {
    return this.sends().filter((entry) => entry.text.includes('ALERTA DE PRUEBA'));
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

interface GuardWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: RecordingInterpreter;
  sessions: SessionStore;
  drafts: DraftEngine;
  interactions: InteractionStore;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

const MODE_B_TOPICS = new Map<number, number>([
  [GABRIEL, T_GABRIEL],
  [EDWARD, T_EDWARD],
  [ANDRES, T_ANDRES],
]);

async function createGuardWorld(opts?: {
  topics?: Map<number, number>;
  alertsTopicId?: number;
}): Promise<GuardWorld> {
  const statePath = join(mkdtempSync(join(tmpdir(), 'vokath-guard-')), 'mock-state.json');
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath,
  });
  const client = new StubTelegramClient();
  const interpreter = new RecordingInterpreter();
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
    ...(opts?.topics !== undefined ? { operatorTopics: opts.topics } : { operatorTopics: MODE_B_TOPICS }),
    ...(opts?.alertsTopicId !== undefined
      ? { alertsTopicId: opts.alertsTopicId }
      : { alertsTopicId: T_ALERTS }),
  });
  // Seed display names so ownership labels are deterministic without setup posts.
  interactions.rememberOperator(GROUP_CHAT_ID, GABRIEL, 'Gabriel');
  interactions.rememberOperator(GROUP_CHAT_ID, EDWARD, 'Edward');
  interactions.rememberOperator(GROUP_CHAT_ID, ANDRES, 'Andres');
  let counter = 5000;
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

function guardMessage(
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

function guardCallback(
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

describe('central topic-ownership guard (Mode B root fix)', () => {
  it('1. Gabriel /start in his own topic works', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), GABRIEL, '/start', T_GABRIEL));
    expect(world.client.texts().at(-1)).toContain('🏠 Vokath');
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Gabriel');
    expect(world.client.sends().at(-1)?.messageThreadId).toBe(T_GABRIEL);
    await world.app.close();
  });

  it('2. Gabriel /start in Edward topic is rejected', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), GABRIEL, '/start', T_EDWARD));
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Edward. Usa tu topic 👤 Gabriel.',
    );
    expect(world.interpreter.calls).toBe(0);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })).toBeUndefined();
    await world.app.close();
  });

  it('3. Gabriel /start in Andres topic is rejected', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), GABRIEL, '/start', T_ANDRES));
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Andres. Usa tu topic 👤 Gabriel.',
    );
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('4. Edward /start in his own topic works', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), EDWARD, '/start', T_EDWARD));
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Edward');
    expect(world.client.sends().at(-1)?.messageThreadId).toBe(T_EDWARD);
    await world.app.close();
  });

  it('5. Edward /start in Gabriel topic is rejected', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), EDWARD, '/start', T_GABRIEL));
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Gabriel. Usa tu topic 👤 Edward.',
    );
    expect(world.interpreter.calls).toBe(0);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })).toBeUndefined();
    await world.app.close();
  });

  it('6. Andres /start in his own topic works', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), ANDRES, '/start', T_ANDRES));
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Andres');
    expect(world.client.sends().at(-1)?.messageThreadId).toBe(T_ANDRES);
    await world.app.close();
  });

  it('7. Andres /start in Gabriel and Edward topics is rejected', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), ANDRES, '/start', T_GABRIEL));
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Gabriel. Usa tu topic 👤 Andres.',
    );
    await world.post(guardMessage(world.nextUpdateId(), ANDRES, '/start', T_EDWARD));
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Edward. Usa tu topic 👤 Andres.',
    );
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('8. Gabriel /testalert from his own topic alerts to thread 25', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), GABRIEL, '/testalert', T_GABRIEL));
    const alert = world.client.alertSends()[0];
    expect(alert?.messageThreadId).toBe(T_ALERTS);
    expect(alert?.text).toContain('👤 Operador: Gabriel');
    const confirm = world.client
      .sends()
      .find((entry) => entry.text.includes('Alerta de prueba enviada'));
    expect(confirm?.messageThreadId).toBe(T_GABRIEL);
    await world.app.close();
  });

  it('9. Gabriel /testalert from Edward topic is rejected with zero alert sends', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), GABRIEL, '/testalert', T_EDWARD));
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Edward. Usa tu topic 👤 Gabriel.',
    );
    expect(world.client.alertSends()).toHaveLength(0);
    await world.app.close();
  });

  it('10. Gabriel /testalert from Andres topic is rejected with zero alert sends', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), GABRIEL, '/testalert', T_ANDRES));
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Andres. Usa tu topic 👤 Gabriel.',
    );
    expect(world.client.alertSends()).toHaveLength(0);
    await world.app.close();
  });

  it('11. Edward /testalert from his own topic works', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), EDWARD, '/testalert', T_EDWARD));
    expect(world.client.alertSends()[0]?.messageThreadId).toBe(T_ALERTS);
    await world.app.close();
  });

  it('12. Edward /testalert from Gabriel topic is rejected with zero alert sends', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), EDWARD, '/testalert', T_GABRIEL));
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Gabriel. Usa tu topic 👤 Edward.',
    );
    expect(world.client.alertSends()).toHaveLength(0);
    await world.app.close();
  });

  it('13. Andres /testalert from his own topic works', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), ANDRES, '/testalert', T_ANDRES));
    expect(world.client.alertSends()[0]?.messageThreadId).toBe(T_ALERTS);
    expect(world.client.alertSends()[0]?.text).toContain('👤 Operador: Andres');
    await world.app.close();
  });

  it('14. Andres /testalert from other topics is rejected with zero alert sends', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), ANDRES, '/testalert', T_GABRIEL));
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Gabriel. Usa tu topic 👤 Andres.',
    );
    await world.post(guardMessage(world.nextUpdateId(), ANDRES, '/testalert', T_EDWARD));
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Edward. Usa tu topic 👤 Andres.',
    );
    expect(world.client.alertSends()).toHaveLength(0);
    await world.app.close();
  });

  it('15. Gabriel free text in Edward topic never reaches Gemini', async () => {
    const world = await createGuardWorld();
    await world.post(
      guardMessage(world.nextUpdateId(), GABRIEL, 'quiero buscar un cliente', T_EDWARD),
    );
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Edward. Usa tu topic 👤 Gabriel.',
    );
    await world.app.close();
  });

  it('16. Gabriel phone in Edward topic never reaches search', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), GABRIEL, '4145460657', T_EDWARD));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Edward. Usa tu topic 👤 Gabriel.',
    );
    const gabrielSearch = world.interactions
      .snapshot()
      .find(
        (interaction) =>
          interaction.ownerTelegramUserId === GABRIEL && interaction.type === 'SEARCH',
      );
    expect(gabrielSearch).toBeUndefined();
    await world.app.close();
  });

  it('17. Gabriel button tapped in Edward topic is rejected without mutation', async () => {
    const world = await createGuardWorld();
    await world.post(guardCallback(world.nextUpdateId(), GABRIEL, callbackData('operar'), T_GABRIEL));
    const owned = world.interactions
      .snapshot()
      .find(
        (interaction) =>
          interaction.ownerTelegramUserId === GABRIEL && interaction.type === 'OPERATION',
      );
    expect(owned).toBeDefined();
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    // Same actor taps his own button from the wrong topic: the central
    // guard rejects before L1 ownership checks run.
    await world.post(
      guardCallback(world.nextUpdateId(), GABRIEL, callbackDataFor('confirm', owned?.id ?? 'missing'), T_EDWARD),
    );
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Edward. Usa tu topic 👤 Gabriel.',
    );
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    await world.app.close();
  });

  it('18. Edward pending input is unconsumable from another actor/topic', async () => {
    const world = await createGuardWorld();
    await world.post(guardCallback(world.nextUpdateId(), EDWARD, callbackData('operar'), T_EDWARD));
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })?.months).toBe(1);
    // Gabriel corrects from Edward's topic: guard rejects, Edward's draft untouched.
    await world.post(guardMessage(world.nextUpdateId(), GABRIEL, 'hazlo 9 meses', T_EDWARD));
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Edward. Usa tu topic 👤 Gabriel.',
    );
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })?.months).toBe(1);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })).toBeUndefined();
    await world.app.close();
  });

  it('19. alerts thread 25 is non-operational for users', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), GABRIEL, '/start', T_ALERTS));
    expect(world.client.texts().at(-1)).toBe(
      '⭐ Este topic es solo para alertas. Usa tu espacio de trabajo.',
    );
    await world.post(guardMessage(world.nextUpdateId(), GABRIEL, '/testalert', T_ALERTS));
    expect(world.client.texts().at(-1)).toBe(
      '⭐ Este topic es solo para alertas. Usa tu espacio de trabajo.',
    );
    await world.post(guardMessage(world.nextUpdateId(), GABRIEL, 'netflix', T_ALERTS));
    expect(world.client.texts().at(-1)).toBe(
      '⭐ Este topic es solo para alertas. Usa tu espacio de trabajo.',
    );
    expect(world.client.alertSends()).toHaveLength(0);
    expect(world.interpreter.calls).toBe(0);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })).toBeUndefined();
    expect(world.interactions.snapshot()).toHaveLength(0);
    await world.app.close();
  });

  it('20. General in Mode B starts nothing (guide only)', async () => {
    const world = await createGuardWorld();
    await world.post(guardMessage(world.nextUpdateId(), GABRIEL, '/start'));
    expect(world.client.texts().at(-1)).toBe('👤 Gabriel, usa tu topic de trabajo.');
    expect(world.client.sends().at(-1)?.messageThreadId).toBeUndefined();
    expect(world.interpreter.calls).toBe(0);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })).toBeUndefined();
    expect(world.interactions.snapshot()).toHaveLength(0);
    await world.app.close();
  });

  it('21. AlertService can still publish to thread 25', async () => {
    const world = await createGuardWorld();
    const alerts = new AlertService(world.client);
    const result = await alerts.sendCriticalAlert(
      { chatId: GROUP_CHAT_ID, alertsThreadId: T_ALERTS },
      { type: 'test', title: 'ALERTA DE PRUEBA', summary: 'Infra check.' },
    );
    expect(result).toBe('sent');
    expect(world.client.alertSends()[0]?.messageThreadId).toBe(T_ALERTS);
    await world.app.close();
  });

  it('22. Mode A is unchanged (no mapping, no gate)', async () => {
    const world = await createGuardWorld({ topics: new Map() });
    // Cross-thread /testalert still works in Mode A.
    await world.post(guardMessage(world.nextUpdateId(), GABRIEL, '/testalert', T_EDWARD));
    expect(world.client.alertSends()[0]?.messageThreadId).toBe(T_ALERTS);
    // Cross-thread free text still operates in Mode A.
    await world.post(guardMessage(world.nextUpdateId(), EDWARD, 'netflix', T_GABRIEL));
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    // General still operates in Mode A.
    await world.post(guardMessage(world.nextUpdateId(), GABRIEL, '/start'));
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Gabriel');
    await world.app.close();
  });
});

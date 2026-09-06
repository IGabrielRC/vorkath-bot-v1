import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { StubIntentInterpreter } from '../src/ai/intentInterpreter';
import { parseAuthorizedChatIds, parseAuthorizedIds } from '../src/auth/allowlist';
import { buildApp } from '../src/app';
import type { Env } from '../src/config/env';
import { DraftEngine } from '../src/drafts/engine';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';
import { HOME_TEXT, callbackData } from '../src/telegram/keyboards';
import { registerWebhook } from '../src/telegram/setWebhook';
import { UNAUTHORIZED_TEXT } from '../src/telegram/webhook';

const GABRIEL = 111111111;
const EDWARD = 222222222;
const STRANGER = 999999999;
/** Shared private operating group both owners see (test-only value). */
const GROUP = -1001234567890;

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  TELEGRAM_BOT_TOKEN: 'tok-test-secret',
  TELEGRAM_WEBHOOK_SECRET: 'wh-test-secret-long-enough',
  AUTHORIZED_TELEGRAM_USER_IDS: `${GABRIEL},${EDWARD}`,
  AUTHORIZED_TELEGRAM_CHAT_IDS: `${GROUP}`,
  GEMINI_API_KEY: 'key-test-secret',
  GEMINI_MODEL: 'gemini-2.0-flash',
  PUBLIC_BASE_URL: 'https://example.com',
  REGISTER_TELEGRAM_WEBHOOK: 'false',
  MOCK_STATE_PATH: '/data/mock-state.json',
  DRAFTS_STATE_PATH: '/data/drafts-state.json',
};

class StubTelegramClient implements TelegramClient {
  readonly sent: Array<{ kind: 'send' | 'edit' | 'answer'; payload: unknown }> = [];

  async sendMessage(opts: { chatId: number; text: string; replyMarkup?: unknown }): Promise<unknown> {
    this.sent.push({ kind: 'send', payload: opts });
    return { ok: true };
  }

  async editMessageText(opts: {
    chatId: number;
    messageId: number;
    text: string;
    replyMarkup?: unknown;
  }): Promise<unknown> {
    this.sent.push({ kind: 'edit', payload: opts });
    return { ok: true };
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<unknown> {
    this.sent.push({ kind: 'answer', payload: { callbackQueryId } });
    return { ok: true };
  }

  sends(): Array<{ chatId: number; text: string }> {
    return this.sent
      .filter((entry) => entry.kind === 'send' || entry.kind === 'edit')
      .map((entry) => entry.payload as { chatId: number; text: string });
  }

  texts(): string[] {
    return this.sends().map((entry) => entry.text);
  }
}

interface WebhookWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter;
  sessions: SessionStore;
  drafts: DraftEngine;
  nextUpdateId: () => number;
  post: (update: unknown, secret?: string) => Promise<{ status: number; body: unknown }>;
}

async function createWorld(): Promise<WebhookWorld> {
  const statePath = join(mkdtempSync(join(tmpdir(), 'vokath-wh-')), 'mock-state.json');
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath,
  });
  const client = new StubTelegramClient();
  const interpreter = new StubIntentInterpreter();
  const sessions = new SessionStore();
  const drafts = new DraftEngine();
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions,
    drafts,
    interpreter,
    repos: new MockAccountRepositories(store),
    client,
  });
  let counter = 1000;
  return {
    app,
    client,
    interpreter,
    sessions,
    drafts,
    nextUpdateId: () => {
      counter += 1;
      return counter;
    },
    post: async (update: unknown, secret: string = testEnv.TELEGRAM_WEBHOOK_SECRET) => {
      const response = await app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': secret },
        payload: update,
      });
      return { status: response.statusCode, body: response.json() as unknown };
    },
  };
}

function messageUpdate(updateId: number, userId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: { message_id: 1, from: { id: userId }, chat: { id: GROUP }, text },
  };
}

function callbackUpdate(updateId: number, userId: number, data: string): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: userId },
      message: { message_id: 7, chat: { id: GROUP } },
      data,
    },
  };
}

describe('webhook secret gate + pipeline (RED: PR3 integration)', () => {
  it('rejects a wrong secret with 401 before any pipeline work', async () => {
    const world = await createWorld();
    const { status, body } = await world.post(
      messageUpdate(world.nextUpdateId(), GABRIEL, '/start'),
      'wrong-secret',
    );
    expect(status).toBe(401);
    expect(body).toEqual({ ok: false });
    expect(world.client.sent).toEqual([]);
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });
});

describe('webhook navigation: /start → Home → Buscar → volver → Home', () => {
  it('serves Home on /start with zero Gemini calls and edits in place on nav', async () => {
    const world = await createWorld();

    const start = await world.post(messageUpdate(world.nextUpdateId(), GABRIEL, '/start'));
    expect(start).toEqual({ status: 200, body: { ok: true } });
    expect(world.client.texts()[0]).toContain(HOME_TEXT);
    expect(world.client.texts()[0]).toContain('👤 Operador:');
    expect(world.interpreter.calls).toBe(0);
    expect(world.sessions.getSession(GABRIEL, GROUP)).toBeDefined();

    await world.post(callbackUpdate(world.nextUpdateId(), GABRIEL, callbackData('buscar')));
    const edits = world.client.sent.filter((entry) => entry.kind === 'edit');
    expect(edits.length).toBe(1);
    expect(JSON.stringify(edits[0]?.payload)).toContain('BUSCAR');
    expect(world.interpreter.calls).toBe(0);

    await world.post(callbackUpdate(world.nextUpdateId(), GABRIEL, callbackData('back')));
    expect(world.client.texts().at(-1)).toContain(HOME_TEXT);
    expect(world.interpreter.calls).toBe(0);

    await world.app.close();
  });

  it('routes natural language search intent through L3 (one Gemini call)', async () => {
    const world = await createWorld();
    await world.post(messageUpdate(world.nextUpdateId(), GABRIEL, 'quiero buscar un cliente'));
    expect(world.interpreter.calls).toBe(1);
    expect(world.client.texts().at(-1)).toContain('BUSCAR');
    await world.app.close();
  });
});

describe('webhook MOCK search via L2 (zero Gemini, secret-free replies)', () => {
  it('answers phone search from the fixture without credentials', async () => {
    const world = await createWorld();
    await world.post(messageUpdate(world.nextUpdateId(), GABRIEL, '4145460657'));
    expect(world.interpreter.calls).toBe(0);
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('Anny Tovar');
    expect(last).toContain('4145460657');
    expect(last).not.toContain('resultado(s) MOCK');
    const payload = JSON.stringify(world.client.sent);
    expect(payload).not.toContain('ncsa909');
    expect(payload).not.toContain('contrasena');
    expect(payload).not.toContain('CONTRASEÑA');
    await world.app.close();
  });

  it('answers email search from the fixture without credentials', async () => {
    const world = await createWorld();
    await world.post(
      messageUpdate(world.nextUpdateId(), EDWARD, 'dasdsadasda@gmail.com'),
    );
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    expect(JSON.stringify(world.client.sent)).not.toContain('simara23075');
    await world.app.close();
  });

  it('serves vencidos from the repo seam without credentials', async () => {
    const world = await createWorld();
    await world.post(callbackUpdate(world.nextUpdateId(), GABRIEL, callbackData('vencidos')));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('Vencidos MOCK');
    expect(JSON.stringify(world.client.sent)).not.toContain('contrasena');
    await world.app.close();
  });
});

describe('webhook demo draft 1 → 2 → confirm/cancel with session isolation', () => {
  it('runs Gabriel draft create → correct → confirm, then a dead cancel', async () => {
    const world = await createWorld();

    await world.post(messageUpdate(world.nextUpdateId(), GABRIEL, 'crea una prueba demo'));
    expect(world.interpreter.calls).toBe(1);
    expect(world.client.texts().at(-1)).toContain('Borrador MOCK abierto');

    await world.post(messageUpdate(world.nextUpdateId(), GABRIEL, 'mejor hazlo 2 meses'));
    expect(world.client.texts().at(-1)).toContain('Borrador actualizado: 2 mes(es)');

    await world.post(callbackUpdate(world.nextUpdateId(), GABRIEL, callbackData('confirm')));
    expect(world.client.texts().at(-1)).toContain('✅ Operación MOCK confirmada');

    await world.post(messageUpdate(world.nextUpdateId(), GABRIEL, 'cancelar'));
    expect(world.client.texts().at(-1)).toContain('Sin borrador abierto que cancelar.');
    await world.app.close();
  });

  it('keeps Gabriel and Edward drafts isolated', async () => {
    const world = await createWorld();

    await world.post(callbackUpdate(world.nextUpdateId(), GABRIEL, callbackData('operar')));
    await world.post(messageUpdate(world.nextUpdateId(), EDWARD, 'mejor hazlo 3 meses'));
    expect(world.client.texts().at(-1)).toContain(
      'No hay borrador abierto. Usa ⚡OPERAR para crear uno.',
    );

    await world.post(callbackUpdate(world.nextUpdateId(), EDWARD, callbackData('operar')));
    await world.post(messageUpdate(world.nextUpdateId(), EDWARD, 'mejor hazlo 2 meses'));
    expect(world.client.texts().at(-1)).toContain('Borrador actualizado: 2 mes(es)');

    // Gabriel's draft still holds its own state — Edward's edits never leak.
    expect(world.drafts.get({ chatId: GROUP, userId: GABRIEL })?.status).toBe('open');
    expect(world.drafts.get({ chatId: GROUP, userId: GABRIEL })?.months).toBe(1);
    expect(world.drafts.get({ chatId: GROUP, userId: EDWARD })?.months).toBe(2);

    await world.post(callbackUpdate(world.nextUpdateId(), EDWARD, callbackData('cancel')));
    expect(world.client.texts().at(-1)).toContain('❌ Operación cancelada');
    expect(world.drafts.get({ chatId: GROUP, userId: GABRIEL })?.status).toBe('open');
    await world.app.close();
  });
});

describe('webhook auth + idempotency', () => {
  it('blocks strangers with a neutral reply and zero side-channels', async () => {
    const world = await createWorld();
    await world.post(messageUpdate(world.nextUpdateId(), STRANGER, '/start'));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts()).toEqual([UNAUTHORIZED_TEXT]);
    expect(world.sessions.getSession(STRANGER, GROUP)).toBeUndefined();
    expect(world.drafts.get({ chatId: GROUP, userId: STRANGER })).toBeUndefined();
    await world.app.close();
  });

  it('ignores redelivered update_id values without re-replying', async () => {
    const world = await createWorld();
    const updateId = world.nextUpdateId();
    const first = await world.post(messageUpdate(updateId, GABRIEL, '/start'));
    expect(first).toEqual({ status: 200, body: { ok: true } });
    const sendsAfterFirst = world.client.sent.length;
    expect(sendsAfterFirst).toBeGreaterThan(0);

    const second = await world.post(messageUpdate(updateId, GABRIEL, '/start'));
    expect(second).toEqual({ status: 200, body: { ok: true } });
    expect(world.client.sent.length).toBe(sendsAfterFirst);
    await world.app.close();
  });
});

describe('registerWebhook (setWebhook contract)', () => {
  it('posts url + secret_token + allowed_updates to the Bot API', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const stubFetch = (async (url: string, init: { body?: string }) => {
      const body = JSON.parse(init.body ?? '{}') as unknown;
      calls.push({ url, body });
      return { json: async () => ({ ok: true }) };
    }) as unknown as typeof globalThis.fetch;

    const ok = await registerWebhook(
      {
        telegramBotToken: 'tok-test-secret',
        publicBaseUrl: 'https://example.com/',
        telegramWebhookSecret: 'wh-test-secret-long-enough',
      },
      stubFetch,
    );

    expect(ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe('https://api.telegram.org/bottok-test-secret/setWebhook');
    expect(calls[0]?.body).toEqual({
      url: 'https://example.com/telegram/webhook',
      secret_token: 'wh-test-secret-long-enough',
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    });
  });

  it('returns false when Telegram answers ok=false', async () => {
    const stubFetch = (async () => ({
      json: async () => ({ ok: false, description: 'bad webhook' }),
    })) as unknown as typeof globalThis.fetch;
    await expect(
      registerWebhook(
        {
          telegramBotToken: 'tok-test-secret',
          publicBaseUrl: 'https://example.com',
          telegramWebhookSecret: 'wh-test-secret-long-enough',
        },
        stubFetch,
      ),
    ).resolves.toBe(false);
  });
});

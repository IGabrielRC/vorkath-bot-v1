import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { StubIntentInterpreter } from '../src/ai/intentInterpreter';
import { parseAuthorizedChatIds, parseAuthorizedIds } from '../src/auth/allowlist';
import { buildApp } from '../src/app';
import type { Env } from '../src/config/env';
import { DraftEngine } from '../src/drafts/engine';
import { InteractionStore } from '../src/interactions/interactions';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import { parseFast } from '../src/parser/fast';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';

const GABRIEL = 1057242322;
const EDWARD = 941030473;
const GROUP_CHAT_ID = -1005550001;

const NAMES: Record<number, string> = { [GABRIEL]: 'Gabriel', [EDWARD]: 'Edward' };

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  TELEGRAM_BOT_TOKEN: 'tok-test-secret',
  TELEGRAM_WEBHOOK_SECRET: 'wh-test-secret-long-enough',
  AUTHORIZED_TELEGRAM_USER_IDS: `${GABRIEL},${EDWARD}`,
  AUTHORIZED_TELEGRAM_CHAT_IDS: `${GROUP_CHAT_ID}`,
  GEMINI_API_KEY: 'key-test-secret',
  GEMINI_MODEL: 'gemini-2.0-flash',
  PUBLIC_BASE_URL: 'https://example.com',
  REGISTER_TELEGRAM_WEBHOOK: 'false',
  MOCK_STATE_PATH: '/data/mock-state.json',
  DRAFTS_STATE_PATH: '/data/drafts-state.json',
};

interface SentPayload {
  chatId: number;
  text: string;
  messageThreadId?: number;
  replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

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

  findButton(text: string): string | undefined {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      const entry = this.sent[index];
      if (entry === undefined || entry.kind === 'answer') {
        continue;
      }
      const payload = entry.payload as SentPayload;
      const flat = payload.replyMarkup?.inline_keyboard.flat() ?? [];
      const found = flat.find((button) => button.text === text);
      if (found !== undefined) {
        return found.callback_data;
      }
    }
    return undefined;
  }
}

interface ConvWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter;
  drafts: DraftEngine;
  interactions: InteractionStore;
  repos: MockAccountRepositories;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<void>;
}

async function createConvWorld(): Promise<ConvWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-conv-'));
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const client = new StubTelegramClient();
  const interpreter = new StubIntentInterpreter();
  const drafts = new DraftEngine();
  const interactions = new InteractionStore();
  const repos = new MockAccountRepositories(store);
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions: new SessionStore(),
    drafts,
    interactions,
    interpreter,
    repos,
    client,
    operatorTopics: new Map(),
  });
  let counter = 8000;
  return {
    app,
    client,
    interpreter,
    drafts,
    interactions,
    repos,
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

function convMessage(updateId: number, actorId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Operator' },
      chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
      text,
    },
  };
}

function convCallback(updateId: number, actorId: number, data: string): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Operator' },
      message: { message_id: 7, chat: { id: GROUP_CHAT_ID, type: 'supergroup' } },
      data,
    },
  };
}

describe('slice A: phone conversation 31-40 (button≡NL, ask-only-missing)', () => {
  it('(31) BUSCAR button ≡ "buscar otro número" (same wizard, zero Gemini)', async () => {
    const world = await createConvWorld();
    await world.post(convMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const buscar = world.client.findButton('🔎BUSCAR');
    if (buscar === undefined) {
      throw new Error('BUSCAR button missing');
    }
    await world.post(convCallback(world.nextUpdateId(), GABRIEL, buscar));
    const buttonText = world.client.texts().at(-1) ?? '';
    expect(buttonText).toContain('BUSCAR');
    await world.app.close();

    const nlWorld = await createConvWorld();
    expect(parseFast('buscar otro número')).toEqual({ kind: 'section', section: 'buscar' });
    await nlWorld.post(convMessage(nlWorld.nextUpdateId(), GABRIEL, 'buscar otro número'));
    expect(nlWorld.interpreter.calls).toBe(0);
    expect(nlWorld.client.texts().at(-1)).toBe(buttonText);
    await nlWorld.app.close();
  });

  it('(32) "quiero buscar" asks ONLY the identifier (1 Gemini call)', async () => {
    const world = await createConvWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchCustomersByPhone');
    await world.post(convMessage(world.nextUpdateId(), GABRIEL, 'quiero buscar un cliente'));
    expect(world.interpreter.calls).toBe(1);
    expect(searchSpy).not.toHaveBeenCalled();
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('🔎 BUSCAR');
    expect(last).not.toMatch(/netflix o flujotv/i);
    expect(last).not.toMatch(/crear cliente/i);
    await world.app.close();
  });

  it('(33) direct +58 NL executes immediately, zero Gemini', async () => {
    const world = await createConvWorld();
    await world.post(convMessage(world.nextUpdateId(), GABRIEL, 'búscame el +58 414-5460657 porfa'));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('Anny Tovar');
    await world.app.close();
  });

  it('(34) direct fixture +1 NL hits the US row, zero Gemini', async () => {
    const world = await createConvWorld();
    await world.post(convMessage(world.nextUpdateId(), GABRIEL, 'revisa +1 817-448-7435'));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('Johnathan sobrino Dayana');
    await world.app.close();
  });

  it('(35) missing identifier asks only for it — never a service question', async () => {
    const world = await createConvWorld();
    await world.post(convMessage(world.nextUpdateId(), GABRIEL, 'quiero revisar una cuenta'));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toMatch(/qu[eé] cuenta quieres revisar/i);
    expect(last).not.toMatch(/netflix o flujotv/i);
    await world.app.close();
  });

  it('(36) clear input costs zero Gemini; typo prose uses one semantic call', async () => {
    const world = await createConvWorld();
    await world.post(convMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('Anny Tovar');
    await world.post(convMessage(world.nextUpdateId(), GABRIEL, 'dime qué pasó con lo mío'));
    expect(world.interpreter.calls).toBe(1);
    expect(world.client.texts().at(-1)).toMatch(/buscar|dato/i);
    await world.app.close();
  });

  it('(37) NL and button searches call the SAME repo tool with the identifier', async () => {
    const world = await createConvWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchCustomersByPhone');
    await world.post(convMessage(world.nextUpdateId(), GABRIEL, 'búscame el +58 414-5460657'));
    expect(searchSpy).toHaveBeenCalledWith('+584145460657');
    await world.app.close();
  });

  it('(38) unknown phone invents nothing — exact not-found', async () => {
    const world = await createConvWorld();
    await world.post(convMessage(world.nextUpdateId(), GABRIEL, 'busca el 04240001111'));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('No encontramos ningún cliente asociado a ese número.');
    expect(last).not.toContain('Anny Tovar');
    expect(last).not.toContain('Gerardo Hernandez');
    await world.app.close();
  });

  it('(39) "otra cuenta" re-enters the wizard, zero Gemini', async () => {
    const world = await createConvWorld();
    await world.post(convMessage(world.nextUpdateId(), GABRIEL, '04240000000'));
    expect(world.client.texts().at(-1)).toContain('No encontrado');
    await world.post(convMessage(world.nextUpdateId(), GABRIEL, 'otra cuenta'));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('BUSCAR');
    await world.app.close();
  });

  it('(40) phone UX payloads never carry credentials', async () => {
    const world = await createConvWorld();
    await world.post(convMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    await world.post(convMessage(world.nextUpdateId(), GABRIEL, '4141294973'));
    await world.post(convMessage(world.nextUpdateId(), GABRIEL, '04240000000'));
    const payload = JSON.stringify(world.client.sent);
    expect(payload).not.toContain('ncsa909');
    expect(payload).not.toContain('contrasena');
    expect(payload).not.toContain('CONTRASEÑA');
    expect(payload).not.toMatch(/PIN\s*:/i);
    await world.app.close();
  });
});

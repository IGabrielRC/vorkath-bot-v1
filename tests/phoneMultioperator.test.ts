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
import { CustomerSelectionStore, type Customer } from '../src/mock/customers';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import { SessionStore } from '../src/session/store';
import { callbackDataFor } from '../src/telegram/keyboards';
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

  toasts(): Array<{ callbackQueryId: string; text?: string }> {
    return this.sent
      .filter((entry) => entry.kind === 'answer')
      .map((entry) => entry.payload as { callbackQueryId: string; text?: string });
  }
}

interface MultiWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter;
  drafts: DraftEngine;
  interactions: InteractionStore;
  repos: MockAccountRepositories;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<void>;
}

async function createMultiWorld(): Promise<MultiWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-multi-'));
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
  let counter = 6000;
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

function multiMessage(updateId: number, actorId: number, text: string): unknown {
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

function multiCallback(updateId: number, actorId: number, data: string): unknown {
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

function gabrielSearch(world: MultiWorld): string {
  const found = world.interactions
    .snapshot()
    .find((i) => i.ownerTelegramUserId === GABRIEL && i.type === 'SEARCH');
  if (found === undefined) {
    throw new Error('Gabriel SEARCH interaction missing');
  }
  return found.id;
}

describe('slice A: phone multioperator 41-47 (ownership, isolation, drafts)', () => {
  it('(41) a peer tapping Ver cliente is rejected and changes nothing', async () => {
    const world = await createMultiWorld();
    await world.post(multiMessage(world.nextUpdateId(), GABRIEL, '4141294973'));
    const interactionId = gabrielSearch(world);
    const before = world.client.texts().length;
    await world.post(
      multiCallback(world.nextUpdateId(), EDWARD, callbackDataFor('view0', interactionId)),
    );
    const toast = world.client.toasts().at(-1);
    expect(toast?.text).toMatch(/pertenece/i);
    expect(world.client.texts().length).toBe(before);
    const edwardSearch = world.interactions
      .snapshot()
      .find((i) => i.ownerTelegramUserId === EDWARD && i.type === 'SEARCH');
    expect(edwardSearch).toBeUndefined();
    await world.app.close();
  });

  it('(42) selection ownership: only the owner opens the card', async () => {
    const world = await createMultiWorld();
    await world.post(multiMessage(world.nextUpdateId(), GABRIEL, '4141294973'));
    const interactionId = gabrielSearch(world);
    await world.post(
      multiCallback(world.nextUpdateId(), EDWARD, callbackDataFor('view1', interactionId)),
    );
    const texts = world.client.texts();
    expect(texts.at(-1)).toMatch(/elige uno/i);
    await world.post(
      multiCallback(world.nextUpdateId(), GABRIEL, callbackDataFor('view1', interactionId)),
    );
    const customers = await world.repos.searchCustomersByPhone('4141294973');
    expect(world.client.texts().at(-1)).toContain(customers[1]!.nombre);
    await world.app.close();
  });

  it('(43) simultaneous searches stay isolated per actor', async () => {
    const world = await createMultiWorld();
    await world.post(multiMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    await world.post(multiMessage(world.nextUpdateId(), EDWARD, '4124086018'));
    const texts = world.client.texts();
    expect(texts[texts.length - 2]).toContain('Anny Tovar');
    expect(texts[texts.length - 1]).toContain('Gerardo Hernandez');
    const gabriel = world.interactions
      .snapshot()
      .filter((i) => i.ownerTelegramUserId === GABRIEL && i.type === 'SEARCH');
    const edward = world.interactions
      .snapshot()
      .filter((i) => i.ownerTelegramUserId === EDWARD && i.type === 'SEARCH');
    expect(gabriel).toHaveLength(1);
    expect(edward).toHaveLength(1);
    expect(gabriel[0]?.state['query']).toBe('4145460657');
    expect(edward[0]?.state['query']).toBe('4124086018');
    await world.app.close();
  });

  it('(44) a pending draft survives phone searches', async () => {
    const world = await createMultiWorld();
    await world.post(multiMessage(world.nextUpdateId(), GABRIEL, 'crea una prueba de 2 meses'));
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    await world.post(multiMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    expect(world.client.texts().at(-1)).toContain('Anny Tovar');
    const draft = world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL });
    expect(draft?.status).toBe('open');
    expect(draft?.months).toBe(2);
    await world.post(multiMessage(world.nextUpdateId(), GABRIEL, '04240000000'));
    expect(world.client.texts().at(-1)).toContain('🔎 NO ENCONTRADO');
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    await world.app.close();
  });

  it('(45) phone searches never create, update, or cancel drafts', async () => {
    const world = await createMultiWorld();
    const createSpy = vi.spyOn(world.drafts, 'create');
    const updateSpy = vi.spyOn(world.drafts, 'update');
    const confirmSpy = vi.spyOn(world.drafts, 'confirm');
    const cancelSpy = vi.spyOn(world.drafts, 'cancel');
    await world.post(multiMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    await world.post(multiMessage(world.nextUpdateId(), GABRIEL, '4141294973'));
    await world.post(multiMessage(world.nextUpdateId(), GABRIEL, '04240000000'));
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })).toBeUndefined();
    await world.app.close();
  });

  it('(46) stale/forged selection callbacks are safe no-ops', async () => {
    const world = await createMultiWorld();
    await world.post(multiMessage(world.nextUpdateId(), GABRIEL, '4141294973'));
    const before = world.client.texts().length;
    await world.post(
      multiCallback(world.nextUpdateId(), GABRIEL, callbackDataFor('view0', 'deadbeef')),
    );
    expect(world.client.texts().length).toBe(before);
    const stored = world.interactions.get('deadbeef');
    expect(stored).toBeUndefined();
    // The owned search still works afterwards.
    await world.post(
      multiCallback(world.nextUpdateId(), GABRIEL, callbackDataFor('view0', gabrielSearch(world))),
    );
    expect(world.client.texts().length).toBeGreaterThan(before);
    await world.app.close();
  });

  it('(47) lastSelectedCustomer is stored per actor and never leaks', () => {
    const store = new CustomerSelectionStore();
    const stefania: Customer = { id: 'stefania marmai (gian)', nombre: 'Stefania Marmai (Gian)', phones: ['4141294973'], subscriptions: [] };
    const iliana: Customer = { id: 'iliana rodriguez', nombre: 'Iliana Rodriguez', phones: ['4141294973'], subscriptions: [] };
    expect(store.lastSelected(GROUP_CHAT_ID, GABRIEL)).toBeUndefined();
    store.select(GROUP_CHAT_ID, GABRIEL, stefania);
    store.select(GROUP_CHAT_ID, EDWARD, iliana);
    expect(store.lastSelected(GROUP_CHAT_ID, GABRIEL)?.nombre).toBe('Stefania Marmai (Gian)');
    expect(store.lastSelected(GROUP_CHAT_ID, EDWARD)?.nombre).toBe('Iliana Rodriguez');
  });
});

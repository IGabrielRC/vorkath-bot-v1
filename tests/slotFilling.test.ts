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
import {
  extractEmbeddedAccount,
  parseCreateTest,
  parseFast,
} from '../src/parser/fast';
import { route } from '../src/router/hybrid';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';
import { callbackDataFor } from '../src/telegram/keyboards';
import {
  pickSearchIdentifier,
  resolveMissingFields,
} from '../src/tools/requirements';

/**
 * Ask-only-what-is-missing slot filling (root-cause fix).
 *
 * Root cause: "revísame una cuenta maxnet050" parsed as SEARCH but the
 * L3 branch always rendered the search-start wizard, dropping the
 * already-provided identifier. These tests lock the fix with REAL
 * fixture values (maxnet050 = Jackson Amaya / FlujoTV, 4145460657 =
 * Anny Tovar, dasdsadasda@gmail.com = Netflix rows).
 */
const GABRIEL = 1057242322;
const EDWARD = 941030473;
const GROUP_CHAT_ID = -1005550001;
const THREAD_GABRIEL = 101;
const THREAD_EDWARD = 202;

const NAMES: Record<number, string> = {
  [GABRIEL]: 'Gabriel',
  [EDWARD]: 'Edward',
};

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

  async answerCallbackQuery(callbackQueryId: string): Promise<unknown> {
    this.sent.push({ kind: 'answer', payload: { callbackQueryId } });
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

interface SlotWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter;
  drafts: DraftEngine;
  interactions: InteractionStore;
  repos: MockAccountRepositories;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

async function createSlotWorld(topics?: Map<number, number>): Promise<SlotWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-slot-'));
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
    operatorTopics: topics ?? new Map(),
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

function slotMessage(updateId: number, actorId: number, text: string, threadId?: number): unknown {
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

function slotCallback(updateId: number, actorId: number, data: string, threadId?: number): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Operator' },
      message: {
        message_id: 7,
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
        chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
      },
      data,
    },
  };
}

/** The forbidden follow-ups: service choice, phone demand, out-of-flow creation. */
const SERVICE_QUESTION_RE = /netflix o flujo|qu[eé] servicio|cu[aá]l servicio|elegir servicio|elige .*servicio/i;
const CREATE_CLIENT_RE = /crear cliente/i;

describe('slot filling: L2 extraction (unit)', () => {
  it('extracts the identifier out of conversational NL', () => {
    expect(parseFast('revísame una cuenta maxnet050')).toEqual({
      kind: 'account',
      value: 'maxnet050',
    });
    expect(parseFast('qué pasa con maxnet050')).toEqual({
      kind: 'account',
      value: 'maxnet050',
    });
    expect(parseFast('revisa maxnet050.')).toEqual({
      kind: 'account',
      value: 'maxnet050',
    });
  });

  it('keeps phone/email priority anywhere in the text', () => {
    expect(parseFast('busca 4145460657')).toEqual({ kind: 'phone', value: '4145460657' });
    expect(parseFast('busca usuario@gmail.com')).toMatchObject({ kind: 'email' });
  });

  it('leaves identifier-less requests for the missing-field question', () => {
    expect(parseFast('quiero revisar una cuenta')).toEqual({ kind: 'none' });
    expect(parseFast('quiero buscar un cliente')).toEqual({ kind: 'none' });
  });

  it('never turns short digit strings into account searches', () => {
    expect(extractEmbeddedAccount('ponlo 2 meses')).toBeNull();
    expect(extractEmbeddedAccount('busca 123')).toBeNull();
    expect(extractEmbeddedAccount('hola, ¿qué tal?')).toBeNull();
  });

  it('parses a complete mutation up front without stealing bare corrections', () => {
    expect(parseCreateTest('crea una prueba de 2 meses')).toEqual({
      kind: 'createTest',
      months: 2,
    });
    expect(parseFast('crea una prueba de 2 meses')).toEqual({
      kind: 'createTest',
      months: 2,
    });
    expect(parseCreateTest('crea una prueba')).toBeNull();
    expect(parseFast('hazlo 2 meses')).toEqual({ kind: 'months', months: 2 });
  });
});

describe('slot filling: missing-fields resolver (unit)', () => {
  it('reports the identifier missing only when nothing usable was given', () => {
    expect(resolveMissingFields('searchAccount', {})).toEqual(['identifier']);
    expect(resolveMissingFields('searchAccount', { identifier: '' })).toEqual(['identifier']);
    expect(resolveMissingFields('searchAccount', { identifier: 'maxnet050' })).toEqual([]);
  });

  it('reports months missing only for incomplete mutations', () => {
    expect(resolveMissingFields('demoCreateTest', {})).toEqual(['months']);
    expect(resolveMissingFields('demoCreateTest', { months: 2 })).toEqual([]);
  });

  it('picks the identifier out of every param alias, never inventing one', () => {
    expect(pickSearchIdentifier({ identifier: 'maxnet050' })).toBe('maxnet050');
    expect(pickSearchIdentifier({ phone: '4145460657' })).toBe('4145460657');
    expect(pickSearchIdentifier({ email: 'a@b.com' })).toBe('a@b.com');
    expect(pickSearchIdentifier({})).toBeUndefined();
    expect(pickSearchIdentifier({ identifier: '  ' })).toBeUndefined();
  });
});

describe('slot filling: router priority (unit)', () => {
  it('(17) obvious phone/email/account NL stays L2 with zero Gemini', async () => {
    const stub = new StubIntentInterpreter();
    expect(await route({ userId: GABRIEL, text: 'busca 4145460657' }, stub)).toMatchObject({
      layer: 'L2',
    });
    expect(await route({ userId: GABRIEL, text: 'busca usuario@gmail.com' }, stub)).toMatchObject({
      layer: 'L2',
    });
    expect(
      await route({ userId: GABRIEL, text: 'revísame una cuenta maxnet050' }, stub),
    ).toMatchObject({ layer: 'L2' });
    expect(stub.calls).toBe(0);
  });

  it('(16) the stub never invents absent params (missing stays missing)', async () => {
    const stub = new StubIntentInterpreter();
    const search = await stub.interpret('quiero revisar una cuenta', { userId: GABRIEL });
    expect(search.name).toBe('OPEN_SEARCH');
    expect(search.params).toEqual({});
    const mutation = await stub.interpret('quiero crear una prueba', { userId: GABRIEL });
    expect(mutation.name).toBe('CREATE_TEST_DRAFT');
    expect(mutation.params).toEqual({});
    const reference = await stub.interpret('esa misma, revísame cuándo vence', {
      userId: GABRIEL,
    });
    expect(reference).toMatchObject({
      name: 'OPEN_SEARCH',
      params: { reference: 'last' },
    });
  });
});

describe('slot filling: search with identifier (webhook)', () => {
  it('(1) "revísame una cuenta maxnet050" searches directly, no phone prompt', async () => {
    const world = await createSlotWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchAccounts');
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'revísame una cuenta maxnet050'));
    expect(world.interpreter.calls).toBe(0);
    expect(searchSpy).toHaveBeenCalledWith('maxnet050');
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('resultado(s) MOCK');
    expect(last).toContain('Jackson Amaya');
    expect(last).not.toMatch(/teléfono/i);
    expect(last).not.toMatch(SERVICE_QUESTION_RE);
    await world.app.close();
  });

  it('(2) "busca maxnet050" searches directly', async () => {
    const world = await createSlotWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchAccounts');
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'busca maxnet050'));
    expect(world.interpreter.calls).toBe(0);
    expect(searchSpy).toHaveBeenCalledWith('maxnet050');
    expect(world.client.texts().at(-1)).toContain('Jackson Amaya');
    await world.app.close();
  });

  it('(3) "qué pasa con maxnet050" attempts the deterministic search', async () => {
    const world = await createSlotWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchAccounts');
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'qué pasa con maxnet050'));
    expect(searchSpy).toHaveBeenCalledWith('maxnet050');
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    await world.app.close();
  });

  it('(4) "busca 4145460657" extracts the phone and searches directly', async () => {
    const world = await createSlotWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchAccounts');
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'busca 4145460657'));
    expect(world.interpreter.calls).toBe(0);
    expect(searchSpy).toHaveBeenCalledWith('4145460657');
    expect(world.client.texts().at(-1)).toContain('Anny Tovar');
    await world.app.close();
  });

  it('(5) email NL searches directly; unknown email reports not-found without offering creation', async () => {
    const world = await createSlotWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchAccounts');
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'busca dasdsadasda@gmail.com'));
    expect(world.interpreter.calls).toBe(0);
    expect(searchSpy).toHaveBeenCalledWith('dasdsadasda@gmail.com');
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');

    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'busca usuario@gmail.com'));
    expect(searchSpy).toHaveBeenCalledWith('usuario@gmail.com');
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('Sin resultados');
    expect(last).toMatch(/reintentar|Volver/);
    expect(last).not.toMatch(CREATE_CLIENT_RE);
    await world.app.close();
  });

  it('(6) "quiero revisar una cuenta" asks ONLY for the identifier', async () => {
    const world = await createSlotWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchAccounts');
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'quiero revisar una cuenta'));
    expect(world.interpreter.calls).toBe(1);
    expect(searchSpy).not.toHaveBeenCalled();
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toMatch(/qué cuenta quieres revisar/i);
    expect(last).not.toContain('resultado(s) MOCK');
    expect(last).not.toMatch(SERVICE_QUESTION_RE);
    expect(last).not.toMatch(CREATE_CLIENT_RE);
    const prompts = world.interactions
      .snapshot()
      .filter((interaction) => interaction.type === 'SEARCH' && interaction.status === 'PENDING');
    expect(prompts).toHaveLength(1);
    await world.app.close();
  });

  it('(7) "quiero buscar un cliente" asks ONLY for the needed identifier', async () => {
    const world = await createSlotWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchAccounts');
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'quiero buscar un cliente'));
    expect(world.interpreter.calls).toBe(1);
    expect(searchSpy).not.toHaveBeenCalled();
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('🔎 BUSCAR');
    expect(last).not.toMatch(SERVICE_QUESTION_RE);
    expect(last).not.toMatch(CREATE_CLIENT_RE);
    await world.app.close();
  });
});

describe('slot filling: buttons, shared tool, disambiguation (webhook)', () => {
  it('(8) dataless Buscar button opens the guided wizard (no search)', async () => {
    const world = await createSlotWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchAccounts');
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const buscar = world.client.findButton('🔎BUSCAR');
    if (buscar === undefined) {
      throw new Error('BUSCAR button missing');
    }
    await world.post(slotCallback(world.nextUpdateId(), GABRIEL, buscar));
    expect(world.interpreter.calls).toBe(0);
    expect(searchSpy).not.toHaveBeenCalled();
    expect(world.client.texts().at(-1)).toContain('🔎 BUSCAR');
    const prompt = world.interactions
      .snapshot()
      .find((interaction) => interaction.type === 'SEARCH' && interaction.status === 'PENDING');
    expect(prompt?.state['view']).toBe('prompt');
    await world.app.close();
  });

  it('(9) button flow input and parameterized NL end in the SAME search tool', async () => {
    const world = await createSlotWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchAccounts');
    // Parameterized NL first.
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'revísame maxnet050'));
    expect(searchSpy).toHaveBeenCalledWith('maxnet050');
    // Guided wizard: tap Buscar, then type the identifier bare.
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const buscar = world.client.findButton('🔎BUSCAR');
    if (buscar === undefined) {
      throw new Error('BUSCAR button missing');
    }
    await world.post(slotCallback(world.nextUpdateId(), GABRIEL, buscar));
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'maxnet050'));
    const calls = searchSpy.mock.calls.filter((call) => call[0] === 'maxnet050');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(world.client.texts().at(-1)).toContain('Jackson Amaya');
    await world.app.close();
  });

  it('(10) no service question is ever asked when the repo discovers it', async () => {
    const world = await createSlotWorld();
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'revísame maxnet050'));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('resultado(s) MOCK');
    expect(last).not.toMatch(SERVICE_QUESTION_RE);
    await world.app.close();
  });

  it('(11) a FlujoTV-only account returns FlujoTV unprompted', async () => {
    const world = await createSlotWorld();
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'revísame maxnet050'));
    const search = world.interactions
      .snapshot()
      .find(
        (interaction) =>
          interaction.ownerTelegramUserId === GABRIEL && interaction.type === 'SEARCH',
      );
    if (search === undefined) {
      throw new Error('SEARCH interaction missing');
    }
    await world.post(slotCallback(world.nextUpdateId(), GABRIEL, callbackDataFor('view0', search.id)));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toMatch(/flujotv/i);
    expect(last).toContain('Jackson Amaya');
    for (const text of world.client.texts()) {
      expect(text).not.toMatch(SERVICE_QUESTION_RE);
    }
    await world.app.close();
  });

  it('(12) real ambiguity yields minimal disambiguation only', async () => {
    const world = await createSlotWorld();
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('resultado(s) MOCK');
    expect(last).not.toMatch(SERVICE_QUESTION_RE);
    expect(last).not.toMatch(CREATE_CLIENT_RE);
    expect(world.client.findButton('1️⃣ Ver cliente')).toBeDefined();
    await world.app.close();
  });
});

describe('slot filling: reads vs drafts (webhook)', () => {
  it('(13) a complete read executes with no confirmation step', async () => {
    const world = await createSlotWorld();
    const draftSpy = vi.spyOn(world.drafts, 'create');
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'revísame maxnet050'));
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    expect(draftSpy).not.toHaveBeenCalled();
    expect(world.client.findButton('✅Confirmar')).toBeUndefined();
    await world.app.close();
  });

  it('(14) a complete mutation builds a draft + confirmation request', async () => {
    const world = await createSlotWorld();
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'crea una prueba de 2 meses'));
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.months).toBe(2);
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toMatch(/confirma/i);
    expect(world.client.findButton('✅Confirmar')).toBeDefined();
    expect(world.client.findButton('✏️Corregir')).toBeDefined();
    expect(world.client.findButton('❌Cancelar')).toBeDefined();
    await world.app.close();
  });

  it('(15) an incomplete mutation asks only for the missing months', async () => {
    const world = await createSlotWorld();
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'quiero crear una prueba'));
    expect(world.interpreter.calls).toBe(1);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('Borrador MOCK abierto');
    expect(last).toMatch(/correcci/i);
    expect(last).not.toMatch(/teléfono/i);
    expect(last).not.toMatch(SERVICE_QUESTION_RE);
    expect(last).not.toMatch(CREATE_CLIENT_RE);
    await world.app.close();
  });
});

describe('slot filling: guards and isolation (webhook)', () => {
  it('(18) the topic guard precedes parser/Gemini/tool on parameterized NL', async () => {
    const topics = new Map<number, number>([
      [GABRIEL, THREAD_GABRIEL],
      [EDWARD, THREAD_EDWARD],
    ]);
    const world = await createSlotWorld(topics);
    const searchSpy = vi.spyOn(world.repos, 'searchAccounts');
    await world.post(
      slotMessage(world.nextUpdateId(), GABRIEL, 'revísame una cuenta maxnet050', THREAD_EDWARD),
    );
    expect(world.interpreter.calls).toBe(0);
    expect(searchSpy).not.toHaveBeenCalled();
    expect(world.interactions.snapshot()).toHaveLength(0);
    expect(world.client.texts().at(-1)).toMatch(/pertenece/i);
    await world.app.close();
  });

  it('(19) conversational references resolve from the actor own context only', async () => {
    const world = await createSlotWorld();
    await world.post(slotMessage(world.nextUpdateId(), GABRIEL, 'revísame maxnet050'));
    expect(world.client.texts().at(-1)).toContain('Jackson Amaya');

    // Edward has no context: same words ask him only for the identifier.
    await world.post(
      slotMessage(world.nextUpdateId(), EDWARD, 'esa misma, revísame cuándo vence'),
    );
    const edwardReply = world.client.texts().at(-1) ?? '';
    expect(edwardReply).not.toContain('Jackson Amaya');
    expect(edwardReply).not.toContain('resultado(s) MOCK');
    expect(edwardReply).toMatch(/🔎 BUSCAR|qu[ée] .*buscar|dato/i);

    // Gabriel's own reference resolves to his searched account.
    await world.post(
      slotMessage(world.nextUpdateId(), GABRIEL, 'esa misma, revísame cuándo vence'),
    );
    const gabrielReply = world.client.texts().at(-1) ?? '';
    expect(gabrielReply).toContain('resultado(s) MOCK');
    expect(gabrielReply).toContain('Jackson Amaya');
    await world.app.close();
  });
});

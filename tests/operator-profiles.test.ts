import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
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
import { callbackData } from '../src/telegram/keyboards';

/**
 * OperatorProfile + conversational-contract suite.
 *
 * Conversations 1-8 lock buttons ≡ NL on the same deterministic core.
 * Operators 9-23 lock automatic display names (no manual name tables).
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
const ALERTS_THREAD = 505;

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  TELEGRAM_BOT_TOKEN: 'tok-test-secret',
  TELEGRAM_WEBHOOK_SECRET: 'wh-test-secret-long-enough',
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
  OPERATOR_PROFILES_STATE_PATH: '/data/operator-profiles-state.json',
};

interface MarkupButton {
  text: string;
  callback_data: string;
}

interface SentPayload {
  chatId: number;
  text: string;
  replyMarkup?: { inline_keyboard: MarkupButton[][] };
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

  messages(): SentPayload[] {
    return this.sent
      .filter((entry) => entry.kind === 'send' || entry.kind === 'edit')
      .map((entry) => entry.payload as SentPayload);
  }

  texts(): string[] {
    return this.messages().map((entry) => entry.text);
  }

  sends(): SentPayload[] {
    return this.messages();
  }

  answers(): Array<{ callbackQueryId: string; text?: string }> {
    return this.sent
      .filter((entry) => entry.kind === 'answer')
      .map((entry) => entry.payload as { callbackQueryId: string; text?: string });
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

interface ProfileWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter;
  sessions: SessionStore;
  drafts: DraftEngine;
  interactions: InteractionStore;
  repos: MockAccountRepositories;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

async function createProfileWorld(opts?: {
  topics?: Map<number, number>;
  alertsTopicId?: number;
}): Promise<ProfileWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-prof-'));
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const client = new StubTelegramClient();
  const interpreter = new StubIntentInterpreter();
  const sessions = new SessionStore();
  const drafts = new DraftEngine();
  const interactions = new InteractionStore();
  const repos = new MockAccountRepositories(store);
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions,
    drafts,
    interactions,
    interpreter,
    repos,
    client,
    auditor: createAuditor(),
    operatorTopics: opts?.topics ?? new Map(),
    ...(opts?.alertsTopicId !== undefined ? { alertsTopicId: opts.alertsTopicId } : {}),
    draftsStatePath: join(dir, 'drafts-state.json'),
    interactionsStatePath: join(dir, 'interactions-state.json'),
    operatorProfilesStatePath: join(dir, 'operator-profiles-state.json'),
  });
  let counter = 6000;
  return {
    app,
    client,
    interpreter,
    sessions,
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

interface FromOverride {
  first_name?: string;
  last_name?: string;
  username?: string;
}

function profileMessage(
  updateId: number,
  actorId: number,
  text: string,
  from?: FromOverride,
  threadId?: number,
): unknown {
  const fromPart =
    from !== undefined
      ? { id: actorId, ...from }
      : { id: actorId, first_name: actorId === GABRIEL ? 'Gabriel' : 'Operator' };
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

function profileCallback(
  updateId: number,
  actorId: number,
  data: string,
  from?: FromOverride,
  threadId?: number,
): unknown {
  const fromPart =
    from !== undefined
      ? { id: actorId, ...from }
      : { id: actorId, first_name: actorId === GABRIEL ? 'Gabriel' : 'Operator' };
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: fromPart,
      message: {
        message_id: 7,
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
        chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
      },
      data,
    },
  };
}

/** Body without the trailing `👤 Operador:` label line. */
function bodyOf(text: string): string {
  return text.replace(/\n👤 Operador: [^\n]*$/u, '');
}

describe('conversational contract: buttons ≡ NL (1-8)', () => {
  it('(1) Buscar button ≡ "quiero buscar un cliente" (same SEARCH entry)', async () => {
    const buttonWorld = await createProfileWorld();
    await buttonWorld.post(profileMessage(buttonWorld.nextUpdateId(), GABRIEL, '/start'));
    const buscar = buttonWorld.client.findButton('🔎BUSCAR');
    if (buscar === undefined) {
      throw new Error('BUSCAR button missing');
    }
    const createSpyButton = vi.spyOn(buttonWorld.interactions, 'create');
    await buttonWorld.post(profileCallback(buttonWorld.nextUpdateId(), GABRIEL, buscar));
    const buttonText = buttonWorld.client.texts().at(-1) ?? '';

    const nlWorld = await createProfileWorld();
    const createSpyNl = vi.spyOn(nlWorld.interactions, 'create');
    await nlWorld.post(
      profileMessage(nlWorld.nextUpdateId(), GABRIEL, 'quiero buscar un cliente'),
    );
    const nlText = nlWorld.client.texts().at(-1) ?? '';

    // Same deterministic prompt through the same entry point.
    expect(bodyOf(buttonText)).toBe(bodyOf(nlText));
    expect(buttonText).toContain('🔎 BUSCAR');
    expect(
      createSpyButton.mock.calls.filter((call) => call[2] === 'SEARCH'),
    ).toHaveLength(1);
    expect(createSpyNl.mock.calls.filter((call) => call[2] === 'SEARCH')).toHaveLength(1);
    // The button costs zero Gemini; the phrase costs exactly one L3 call.
    expect(buttonWorld.interpreter.calls).toBe(0);
    expect(nlWorld.interpreter.calls).toBe(1);
    await buttonWorld.app.close();
    await nlWorld.app.close();
  });

  it('(2) Operar button ≡ natural operate request (same draft infra)', async () => {
    const buttonWorld = await createProfileWorld();
    await buttonWorld.post(profileMessage(buttonWorld.nextUpdateId(), GABRIEL, '/start'));
    const operar = buttonWorld.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    const draftSpyButton = vi.spyOn(buttonWorld.drafts, 'create');
    await buttonWorld.post(profileCallback(buttonWorld.nextUpdateId(), GABRIEL, operar));
    const buttonText = buttonWorld.client.texts().at(-1) ?? '';

    const nlWorld = await createProfileWorld();
    const draftSpyNl = vi.spyOn(nlWorld.drafts, 'create');
    await nlWorld.post(
      profileMessage(nlWorld.nextUpdateId(), GABRIEL, 'quiero crear una prueba'),
    );
    const nlText = nlWorld.client.texts().at(-1) ?? '';

    expect(bodyOf(buttonText)).toBe(bodyOf(nlText));
    expect(buttonText).toContain('Borrador MOCK abierto');
    expect(buttonWorld.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe(
      'open',
    );
    expect(nlWorld.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe(
      'open',
    );
    expect(draftSpyButton).toHaveBeenCalledTimes(1);
    expect(draftSpyNl).toHaveBeenCalledTimes(1);
    await buttonWorld.app.close();
    await nlWorld.app.close();
  });

  it('(3) equivalent NL phrases → same OPEN_SEARCH intent', async () => {
    const world = await createProfileWorld();
    const phrases = [
      'quiero buscar un cliente',
      'busca a María',
      'por favor busca un cliente',
    ];
    for (const phrase of phrases) {
      await world.post(profileMessage(world.nextUpdateId(), GABRIEL, phrase));
      expect(world.client.texts().at(-1)).toContain('🔎 BUSCAR');
    }
    expect(world.interpreter.calls).toBe(3);
    const searches = world.interactions
      .snapshot()
      .filter((interaction) => interaction.type === 'SEARCH');
    expect(searches).toHaveLength(3);
    await world.app.close();
  });

  it('(4) equivalent operate phrases → same CREATE_TEST_DRAFT intent', async () => {
    for (const phrase of ['quiero crear una prueba', 'hazme una demo', 'opera un test']) {
      const world = await createProfileWorld();
      await world.post(profileMessage(world.nextUpdateId(), GABRIEL, phrase));
      expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe(
        'open',
      );
      expect(world.client.texts().at(-1)).toContain('Borrador MOCK abierto');
      expect(world.interpreter.calls).toBe(1);
      await world.app.close();
    }
  });

  it('(5) fast-parser priority: obvious input costs zero Gemini', async () => {
    const world = await createProfileWorld();
    await world.post(profileMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const operar = world.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    await world.post(profileCallback(world.nextUpdateId(), GABRIEL, operar));
    // Phone, email, months correction, service name, bare account id.
    await world.post(profileMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    expect(world.client.texts().at(-1)).toContain('Anny Tovar');
    await world.post(profileMessage(world.nextUpdateId(), GABRIEL, 'dasdsadasda@gmail.com'));
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    await world.post(profileMessage(world.nextUpdateId(), GABRIEL, 'hazlo 2 meses'));
    expect(world.client.texts().at(-1)).toContain('Borrador actualizado');
    await world.post(profileMessage(world.nextUpdateId(), GABRIEL, 'netflix'));
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    await world.post(profileMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(6) foreign-topic input triggers NEITHER Gemini NOR tools', async () => {
    const topics = new Map<number, number>([
      [GABRIEL, THREAD_GABRIEL],
      [EDWARD, THREAD_EDWARD],
    ]);
    const world = await createProfileWorld({ topics });
    const searchSpy = vi.spyOn(world.repos, 'searchAccounts');
    const draftSpy = vi.spyOn(world.drafts, 'create');
    // Gabriel acts inside Edward's topic: NL + search-shaped + button-like input.
    await world.post(
      profileMessage(world.nextUpdateId(), GABRIEL, 'quiero buscar un cliente', undefined, THREAD_EDWARD),
    );
    expect(world.client.texts().at(-1)).toContain('pertenece a');
    await world.post(
      profileMessage(world.nextUpdateId(), GABRIEL, '4145460657', undefined, THREAD_EDWARD),
    );
    await world.post(
      profileMessage(world.nextUpdateId(), GABRIEL, 'crea una demo', undefined, THREAD_EDWARD),
    );
    expect(world.interpreter.calls).toBe(0);
    expect(searchSpy).not.toHaveBeenCalled();
    expect(draftSpy).not.toHaveBeenCalled();
    expect(world.interactions.snapshot()).toHaveLength(0);
    expect(world.drafts.snapshot()).toHaveLength(0);
    expect(world.sessions.getSession(GABRIEL, GROUP_CHAT_ID)).toBeUndefined();
    await world.app.close();
  });

  it('(7) no duplication: buttons and NL call the same tool functions', async () => {
    // Draft entry shared between callback, command text, and NL.
    const buttonWorld = await createProfileWorld();
    await buttonWorld.post(profileMessage(buttonWorld.nextUpdateId(), GABRIEL, '/start'));
    const operar = buttonWorld.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    const buttonDraftSpy = vi.spyOn(buttonWorld.drafts, 'create');
    await buttonWorld.post(profileCallback(buttonWorld.nextUpdateId(), GABRIEL, operar));
    expect(buttonDraftSpy).toHaveBeenCalledTimes(1);
    expect(buttonDraftSpy.mock.calls[0]?.[0]).toMatchObject({
      chatId: GROUP_CHAT_ID,
      userId: GABRIEL,
    });

    const nlWorld = await createProfileWorld();
    const nlDraftSpy = vi.spyOn(nlWorld.drafts, 'create');
    await nlWorld.post(profileMessage(nlWorld.nextUpdateId(), GABRIEL, 'opera un test'));
    expect(nlDraftSpy).toHaveBeenCalledTimes(1);
    expect(nlDraftSpy.mock.calls[0]?.[0]).toMatchObject({
      chatId: GROUP_CHAT_ID,
      userId: GABRIEL,
    });
    expect(nlDraftSpy.mock.calls[0]?.[0]).toEqual(buttonDraftSpy.mock.calls[0]?.[0]);

    // Search entry shared between phone-shaped and account-shaped NL
    // (one entry point; phone identifiers resolve via the customer seam,
    // account identifiers via the account seam — no duplicated logic).
    const searchWorld = await createProfileWorld();
    const customerSpy = vi.spyOn(searchWorld.repos, 'searchCustomersByPhone');
    const accountSpy = vi.spyOn(searchWorld.repos, 'searchAccounts');
    await searchWorld.post(profileMessage(searchWorld.nextUpdateId(), GABRIEL, '4145460657'));
    await searchWorld.post(profileMessage(searchWorld.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    expect(customerSpy).toHaveBeenCalledWith('4145460657');
    expect(accountSpy).toHaveBeenCalledWith('cmaxnet001');
    expect(searchWorld.interpreter.calls).toBe(0);
    await buttonWorld.app.close();
    await nlWorld.app.close();
    await searchWorld.app.close();
  });

  it('(8) Gemini invoked only when needed', async () => {
    const world = await createProfileWorld();
    await world.post(profileMessage(world.nextUpdateId(), GABRIEL, 'netflix'));
    expect(world.interpreter.calls).toBe(0);
    await world.post(profileMessage(world.nextUpdateId(), GABRIEL, 'confirmar'));
    expect(world.interpreter.calls).toBe(0);
    await world.post(profileMessage(world.nextUpdateId(), GABRIEL, 'hola, ¿qué tal?'));
    expect(world.interpreter.calls).toBe(1);
    expect(world.client.texts().at(-1)).toContain('No entendí');
    await world.app.close();
  });
});

describe('operator profiles: automatic names, id-keyed security (9-23)', () => {
  it('(9) displayName resolves Gabriel from first_name', async () => {
    const world = await createProfileWorld();
    await world.post(
      profileMessage(world.nextUpdateId(), GABRIEL, '/start', { first_name: 'Gabriel' }),
    );
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Gabriel');
    expect(world.interactions.resolveNameByUserId(GROUP_CHAT_ID, GABRIEL)).toBe('Gabriel');
    await world.app.close();
  });

  it('(10) displayName resolves "Andres Perez" from first+last name', async () => {
    const world = await createProfileWorld();
    await world.post(
      profileMessage(world.nextUpdateId(), ANDRES, '/start', {
        first_name: 'Andres',
        last_name: 'Perez',
      }),
    );
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Andres Perez');
    await world.app.close();
  });

  it('(11) first-only name renders without padding', async () => {
    const world = await createProfileWorld();
    await world.post(
      profileMessage(world.nextUpdateId(), ANDRES, '/start', { first_name: 'Andres' }),
    );
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('👤 Operador: Andres');
    expect(last).not.toMatch(/Operador: Andres\s*\n/u);
    await world.app.close();
  });

  it('(12) username-only resolves to @handle', async () => {
    const world = await createProfileWorld();
    await world.post(
      profileMessage(world.nextUpdateId(), ANDRES, '/start', { username: 'andres_gt' }),
    );
    expect(world.client.texts().at(-1)).toContain('👤 Operador: @andres_gt');
    await world.app.close();
  });

  it('(13) nameless update never renders an empty label', async () => {
    const world = await createProfileWorld();
    await world.post(profileMessage(world.nextUpdateId(), ANDRES, '/start', {}));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('👤 Operador: Usuario');
    expect(last).not.toContain(String(ANDRES));
    for (const text of world.client.texts()) {
      expect(text).not.toMatch(/👤 Operador:\s*$/mu);
    }
    await world.app.close();
  });

  it('(14) profile is created on first interaction', async () => {
    const world = await createProfileWorld();
    expect(world.interactions.getOperatorProfile(GABRIEL)).toBeUndefined();
    await world.post(
      profileMessage(world.nextUpdateId(), GABRIEL, '/start', { first_name: 'Gabriel' }),
    );
    const profile = world.interactions.getOperatorProfile(GABRIEL);
    expect(profile?.telegramUserId).toBe(GABRIEL);
    expect(profile?.firstName).toBe('Gabriel');
    expect(profile?.displayName).toBe('Gabriel');
    await world.app.close();
  });

  it('(15) profile refreshes on Telegram rename and survives a file round-trip', async () => {
    const world = await createProfileWorld();
    await world.post(
      profileMessage(world.nextUpdateId(), GABRIEL, '/start', { first_name: 'Gabriel' }),
    );
    await world.post(
      profileMessage(world.nextUpdateId(), GABRIEL, 'netflix', {
        first_name: 'Gabriel',
        last_name: 'Ruiz',
      }),
    );
    const updated = world.interactions.getOperatorProfile(GABRIEL);
    expect(updated?.displayName).toBe('Gabriel Ruiz');
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Gabriel Ruiz');

    // File-snapshot pattern: save, restore into a fresh store, profile intact.
    const dir = mkdtempSync(join(tmpdir(), 'vokath-prof-rt-'));
    const path = join(dir, 'operator-profiles-state.json');
    await world.interactions.saveProfilesToFile(path);
    const restored = new InteractionStore();
    await restored.loadProfilesFromFile(path);
    expect(restored.getOperatorProfile(GABRIEL)?.displayName).toBe('Gabriel Ruiz');
    await world.app.close();
  });

  it('(16) callback_query.from creates and resolves the profile', async () => {
    const world = await createProfileWorld();
    await world.post(
      profileCallback(world.nextUpdateId(), GABRIEL, callbackData('home'), {
        first_name: 'Gabriel',
        last_name: 'Torres',
      }),
    );
    expect(world.interactions.getOperatorProfile(GABRIEL)?.displayName).toBe(
      'Gabriel Torres',
    );
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Gabriel Torres');
    await world.app.close();
  });

  it('(17) rename preserves ownership (id-keyed drafts and buttons)', async () => {
    const world = await createProfileWorld();
    await world.post(
      profileMessage(world.nextUpdateId(), GABRIEL, '/start', { first_name: 'Gabriel' }),
    );
    const operar = world.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    await world.post(profileCallback(world.nextUpdateId(), GABRIEL, operar));
    // Telegram rename mid-flow: correction still lands in the same id-keyed draft.
    await world.post(
      profileMessage(world.nextUpdateId(), GABRIEL, 'hazlo 3 meses', {
        first_name: 'Gabriel',
        last_name: 'Ruiz',
      }),
    );
    expect(world.client.texts().at(-1)).toContain('Borrador actualizado: 3 mes(es)');
    await world.post(profileMessage(world.nextUpdateId(), GABRIEL, 'confirmar'));
    expect(world.client.texts().at(-1)).toContain('✅ Operación MOCK confirmada');
    expect(
      world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status,
    ).toBe('confirmed');
    await world.app.close();
  });

  it('(18) brand-new allowlisted user is auto-named on first touch', async () => {
    const world = await createProfileWorld();
    // No topic mapping, no manual table: Andres was never seen before.
    expect(world.interactions.getOperatorProfile(ANDRES)).toBeUndefined();
    await world.post(
      profileMessage(world.nextUpdateId(), ANDRES, '/start', { first_name: 'Andres' }),
    );
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Andres');
    expect(world.interactions.getOperatorProfile(ANDRES)?.displayName).toBe('Andres');
    await world.app.close();
  });

  it('(19) ownership rejection shows the name, never the raw id', async () => {
    const world = await createProfileWorld();
    await world.post(
      profileMessage(world.nextUpdateId(), GABRIEL, '/start', { first_name: 'Gabriel' }),
    );
    const operar = world.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    await world.post(
      profileCallback(world.nextUpdateId(), EDWARD, operar, { first_name: 'Edward' }),
    );
    const toast = world.client.answers().at(-1)?.text ?? '';
    expect(toast).toBe('Esta acción pertenece a Gabriel.');
    expect(toast).not.toContain(String(GABRIEL));
    await world.app.close();
  });

  it('(20) alert shows the operator name, never the raw id', async () => {
    const world = await createProfileWorld({ alertsTopicId: ALERTS_THREAD });
    await world.post(
      profileMessage(world.nextUpdateId(), GABRIEL, '/testalert', {
        first_name: 'Gabriel',
      }),
    );
    const alert = world.client
      .sends()
      .find((entry) => entry.text.includes('ALERTA DE PRUEBA'));
    expect(alert?.text).toContain('👤 Operador: Gabriel');
    expect(alert?.text).not.toContain(String(GABRIEL));
    await world.app.close();
  });

  it('(21) topic assignment stays id-based across renames', async () => {
    const topics = new Map<number, number>([
      [GABRIEL, THREAD_GABRIEL],
      [EDWARD, THREAD_EDWARD],
    ]);
    const world = await createProfileWorld({ topics });
    // Gabriel renames, then /topicid still works in his own topic.
    await world.post(
      profileMessage(world.nextUpdateId(), GABRIEL, '/topicid', {
        first_name: 'Gabriel',
        last_name: 'Ruiz',
      }, THREAD_GABRIEL),
    );
    expect(world.client.sends()[0]?.text).toContain('Thread ID: 101');
    // Edward in Gabriel's topic: mismatch names both operators by name.
    await world.post(
      profileMessage(world.nextUpdateId(), EDWARD, 'netflix', { first_name: 'Edward' }, THREAD_GABRIEL),
    );
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('Gabriel Ruiz');
    expect(last).toContain('Edward');
    expect(last).not.toContain(String(GABRIEL));
    expect(last).not.toContain(String(EDWARD));
    await world.app.close();
  });

  it('(22) same-name stranger is still blocked', async () => {
    const world = await createProfileWorld();
    await world.post(
      profileMessage(world.nextUpdateId(), GABRIEL, '/start', { first_name: 'Gabriel' }),
    );
    const operar = world.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    // Andres shares Gabriel's first_name but owns nothing: button tap dies on id.
    await world.post(
      profileCallback(world.nextUpdateId(), ANDRES, operar, { first_name: 'Gabriel' }),
    );
    expect(world.client.answers().at(-1)?.text).toBe(
      'Esta acción pertenece a Gabriel.',
    );
    // Reply to Gabriel's labeled message is rejected too.
    const label = world.client.texts().at(-1) ?? '';
    expect(label).toContain('👤 Operador: Gabriel');
    const reply: unknown = {
      update_id: world.nextUpdateId(),
      message: {
        message_id: 9,
        from: { id: ANDRES, first_name: 'Gabriel' },
        chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
        text: 'quiero operar',
        reply_to_message: {
          message_id: 2,
          from: { id: 999, first_name: 'VokathBot', is_bot: true },
          chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
          text: label,
        },
      },
    };
    await world.post(reply);
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este requerimiento pertenece a Gabriel.',
    );
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: ANDRES })).toBeUndefined();
    await world.app.close();
  });

  it('(23) duplicate display names never merge security state', async () => {
    const world = await createProfileWorld();
    await world.post(
      profileMessage(world.nextUpdateId(), GABRIEL, '/start', { first_name: 'Alex' }),
    );
    const gabrielOperar = world.client.findButton('⚡OPERAR');
    if (gabrielOperar === undefined) {
      throw new Error('OPERAR button missing');
    }
    await world.post(
      profileMessage(world.nextUpdateId(), EDWARD, '/start', { first_name: 'Alex' }),
    );
    // Both operators named Alex hold independent drafts keyed by id.
    await world.post(profileCallback(world.nextUpdateId(), GABRIEL, gabrielOperar));
    await world.post(profileMessage(world.nextUpdateId(), EDWARD, 'crea una demo', { first_name: 'Alex' }));
    expect(
      world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status,
    ).toBe('open');
    expect(
      world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })?.status,
    ).toBe('open');
    // Gabriel confirms only his own; Edward's stays open.
    await world.post(profileMessage(world.nextUpdateId(), GABRIEL, 'confirmar', { first_name: 'Alex' }));
    expect(
      world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status,
    ).toBe('confirmed');
    expect(
      world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })?.status,
    ).toBe('open');
    await world.app.close();
  });
});

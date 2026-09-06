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
import { route } from '../src/router/hybrid';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';

/**
 * Conversational twins: EVERY home button (OPERAR/BUSCAR/VENCIDOS/
 * INVENTARIO/CAJA/MÁS) has a natural-language equivalent ending in the
 * SAME handler (same deterministic tool, same reply). Root cause being
 * locked: VENCIDOS/INVENTARIO/CAJA/MÁS had button-only handlers — their
 * NL phrases either fell to UNKNOWN ("No entendí") or were hijacked by
 * the search-verb regex ("dime cuáles están vencidos" opened the search
 * wizard instead of the vencidos placeholder). L2 resolves clear
 * patterns over normalized text (zero Gemini); the stub plays Gemini's
 * semantic role for the rest.
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

interface TwinWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter;
  drafts: DraftEngine;
  interactions: InteractionStore;
  repos: MockAccountRepositories;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<void>;
}

async function createTwinWorld(topics?: Map<number, number>): Promise<TwinWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-twins-'));
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
  let counter = 9000;
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

function twinMessage(updateId: number, actorId: number, text: string, threadId?: number): unknown {
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

function twinCallback(updateId: number, actorId: number, data: string): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Operator' },
      message: {
        message_id: 7,
        chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
      },
      data,
    },
  };
}

/** Taps a home button by visible label (via /start). Throws when missing. */
async function tapHomeButton(world: TwinWorld, actorId: number, label: string): Promise<void> {
  await world.post(twinMessage(world.nextUpdateId(), actorId, '/start'));
  const data = world.client.findButton(label);
  if (data === undefined) {
    throw new Error(`${label} button missing`);
  }
  await world.post(twinCallback(world.nextUpdateId(), actorId, data));
}

describe('twins: L2 section parsing over normalized text (unit)', () => {
  it('OPERAR generic phrases resolve with accents/case tolerance', () => {
    expect(parseFast('quiero hacer una operación')).toEqual({
      kind: 'section',
      section: 'operar',
    });
    expect(parseFast('NECESITO OPERAR')).toEqual({ kind: 'section', section: 'operar' });
    expect(parseFast('quiero operar')).toEqual({ kind: 'section', section: 'operar' });
  });

  it('VENCIDOS phrases resolve with accents/case tolerance', () => {
    expect(parseFast('¿qué se me venció?')).toEqual({ kind: 'section', section: 'vencidos' });
    expect(parseFast('DIME CUÁLES ESTÁN VENCIDOS')).toEqual({
      kind: 'section',
      section: 'vencidos',
    });
    expect(parseFast('hay algo por vencer')).toEqual({ kind: 'section', section: 'vencidos' });
  });

  it('INVENTARIO phrases resolve, including the hay-Netflix availability ask', () => {
    expect(parseFast('¿qué tengo disponible?')).toEqual({
      kind: 'section',
      section: 'inventario',
    });
    expect(parseFast('CÓMO ESTÁ EL INVENTARIO')).toEqual({
      kind: 'section',
      section: 'inventario',
    });
    expect(parseFast('hay Netflix')).toEqual({ kind: 'section', section: 'inventario' });
  });

  it('CAJA phrases resolve with accents/case tolerance', () => {
    expect(parseFast('¿cómo está la caja?')).toEqual({ kind: 'section', section: 'caja' });
    expect(parseFast('QUÉ ENTRÓ HOY')).toEqual({ kind: 'section', section: 'caja' });
  });

  it('MÁS phrases resolve with accents/case tolerance', () => {
    expect(parseFast('¿qué más puedo hacer?')).toEqual({ kind: 'section', section: 'mas' });
    expect(parseFast('muéstrame otras opciones')).toEqual({ kind: 'section', section: 'mas' });
  });

  it('never steals identifier, filtered-service or reference flows', () => {
    // BUSCAR twin is the identifier search itself.
    expect(parseFast('revisame maxnet050 a ver como esta')).toEqual({
      kind: 'account',
      value: 'maxnet050',
    });
    // Filtered service search keeps routing to `service` (future phases).
    expect(parseFast('busca cuentas NETFLIX vencidas')).toEqual({
      kind: 'service',
      value: 'netflix',
    });
    // Bare "vence" belongs to conversational references (L3), not vencidos.
    expect(parseFast('esa misma, revísame cuándo vence')).toEqual({ kind: 'none' });
    // Identifier-less search prose stays L3 (ask-only-missing).
    expect(parseFast('quiero buscar un cliente')).toEqual({ kind: 'none' });
    // Sell/renew are contract-only: L2 declines so nothing executes.
    expect(parseFast('quiero renovar maxnet050')).toEqual({ kind: 'none' });
    expect(parseFast('quiero vender una cuenta')).toEqual({ kind: 'none' });
  });

  it('clear patterns stay L2 with zero Gemini; semantic cases fall to L3', async () => {
    const stub = new StubIntentInterpreter();
    expect(await route({ userId: GABRIEL, text: '¿qué se me venció?' }, stub)).toMatchObject({
      layer: 'L2',
    });
    expect(await route({ userId: GABRIEL, text: 'necesito operar' }, stub)).toMatchObject({
      layer: 'L2',
    });
    expect(stub.calls).toBe(0);
    const semantic = await route({ userId: GABRIEL, text: 'q hay por venser' }, stub);
    expect(semantic).toMatchObject({ layer: 'L3' });
    expect(stub.calls).toBe(1);
  });
});

describe('twins: L3 stub semantic mapping incl. typos (unit)', () => {
  it('maps typo/accent variants to section intents (Gemini role)', async () => {
    const stub = new StubIntentInterpreter();
    expect(await stub.interpret('q hay por venser', { userId: GABRIEL })).toMatchObject({
      name: 'OPEN_EXPIRED',
    });
    expect(await stub.interpret('dime cómo va la kaja', { userId: GABRIEL })).toMatchObject({
      name: 'OPEN_CASH',
    });
    expect(await stub.interpret('queda algo de netflix?', { userId: GABRIEL })).toMatchObject({
      name: 'OPEN_INVENTORY',
    });
    expect(await stub.interpret('que mas hay?', { userId: GABRIEL })).toMatchObject({
      name: 'OPEN_MORE',
    });
    expect(
      await stub.interpret('quiero abrir una prueba', { userId: GABRIEL }),
    ).toMatchObject({ name: 'CREATE_TEST_DRAFT', params: {} });
    // Generic operate with no months → same shell as the OPERAR button.
    // (Production Gemini returns this directly for paraphrases L2 misses;
    // L2 itself resolves the clear forms with zero calls.)
    expect(
      await stub.interpret('quiero hacer una operacion', { userId: GABRIEL }),
    ).toMatchObject({ name: 'OPEN_OPERATE' });
  });

  it('preserves params stated in one phrase (months=5; correction months=3)', async () => {
    const stub = new StubIntentInterpreter();
    expect(
      await stub.interpret('crea una operación de prueba de 5 meses', { userId: GABRIEL }),
    ).toMatchObject({ name: 'CREATE_TEST_DRAFT', params: { months: 5 } });
    expect(
      await stub.interpret('no mejor déjalo en 3 meses', { userId: GABRIEL }),
    ).toMatchObject({ name: 'CORRECTION', params: { months: 3 } });
  });

  it('keeps sell/renew verbs contract-only: UNKNOWN, nothing executes', async () => {
    const stub = new StubIntentInterpreter();
    expect(await stub.interpret('quiero renovar maxnet050', { userId: GABRIEL })).toMatchObject({
      name: 'UNKNOWN',
    });
    expect(await stub.interpret('quiero vender una cuenta', { userId: GABRIEL })).toMatchObject({
      name: 'UNKNOWN',
    });
  });
});

describe('twins: button≈NL equivalence per section (webhook, same handler/tool spy)', () => {
  it('OPERAR button ≡ "quiero hacer una operación" (same draft, same shell)', async () => {
    const buttonWorld = await createTwinWorld();
    const buttonDraftSpy = vi.spyOn(buttonWorld.drafts, 'create');
    await tapHomeButton(buttonWorld, GABRIEL, '⚡OPERAR');
    expect(buttonDraftSpy).toHaveBeenCalledTimes(1);
    const buttonText = buttonWorld.client.texts().at(-1) ?? '';
    expect(buttonText).toContain('Borrador MOCK abierto');
    await buttonWorld.app.close();

    const nlWorld = await createTwinWorld();
    const nlDraftSpy = vi.spyOn(nlWorld.drafts, 'create');
    await nlWorld.post(
      twinMessage(nlWorld.nextUpdateId(), GABRIEL, 'quiero hacer una operación'),
    );
    expect(nlWorld.interpreter.calls).toBe(0);
    expect(nlDraftSpy).toHaveBeenCalledTimes(1);
    expect(nlWorld.client.texts().at(-1)).toBe(buttonText);
    await nlWorld.app.close();
  });

  it('OPERAR paraphrases share the shell: "necesito operar" + semantic operate', async () => {
    const world = await createTwinWorld();
    await world.post(twinMessage(world.nextUpdateId(), GABRIEL, 'necesito operar'));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('Borrador MOCK abierto');
    await world.post(twinMessage(world.nextUpdateId(), EDWARD, 'quiero abrir una prueba'));
    expect(world.interpreter.calls).toBe(1);
    expect(world.client.texts().at(-1)).toContain('Borrador MOCK abierto');
    await world.app.close();
  });

  it('BUSCAR ≡ "revisame maxnet050 a ver como esta" + international phone', async () => {
    const world = await createTwinWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchServiceAccounts');
    const customerSpy = vi.spyOn(world.repos, 'searchCustomersByPhone');
    await world.post(
      twinMessage(world.nextUpdateId(), GABRIEL, 'revisame maxnet050 a ver como esta'),
    );
    expect(world.interpreter.calls).toBe(0);
    expect(searchSpy).toHaveBeenCalledWith('maxnet050');
    expect(world.client.texts().at(-1)).toContain('Jackson Amaya');

    await world.post(twinMessage(world.nextUpdateId(), GABRIEL, '+58 414-5460657'));
    expect(customerSpy).toHaveBeenCalledWith('+584145460657');
    expect(world.client.texts().at(-1)).toContain('Anny Tovar');
    await world.app.close();
  });

  it('VENCIDOS button ≡ NL (same repo tool, same placeholder text)', async () => {
    const buttonWorld = await createTwinWorld();
    const buttonSpy = vi.spyOn(buttonWorld.repos, 'getExpiredAccounts');
    await tapHomeButton(buttonWorld, GABRIEL, '⏰VENCIDOS');
    expect(buttonSpy).toHaveBeenCalledTimes(1);
    const buttonText = buttonWorld.client.texts().at(-1) ?? '';
    expect(buttonText).toContain('Vencidos MOCK');
    await buttonWorld.app.close();

    for (const phrase of [
      '¿qué se me venció?',
      'DIME CUÁLES ESTÁN VENCIDOS',
      'hay algo por vencer',
    ]) {
      const nlWorld = await createTwinWorld();
      const nlSpy = vi.spyOn(nlWorld.repos, 'getExpiredAccounts');
      await nlWorld.post(twinMessage(nlWorld.nextUpdateId(), GABRIEL, phrase));
      expect(nlWorld.interpreter.calls).toBe(0);
      expect(nlSpy).toHaveBeenCalledTimes(1);
      expect(nlWorld.client.texts().at(-1)).toBe(buttonText);
      await nlWorld.app.close();
    }
  });

  it('VENCIDOS semantic typo still lands the placeholder via Gemini (1 call)', async () => {
    const world = await createTwinWorld();
    const expiredSpy = vi.spyOn(world.repos, 'getExpiredAccounts');
    await world.post(twinMessage(world.nextUpdateId(), GABRIEL, 'q hay por venser'));
    expect(world.interpreter.calls).toBe(1);
    expect(expiredSpy).toHaveBeenCalledTimes(1);
    expect(world.client.texts().at(-1)).toContain('Vencidos MOCK');
    await world.app.close();
  });

  it('INVENTARIO button ≡ NL (same repo tool, same placeholder text)', async () => {
    const buttonWorld = await createTwinWorld();
    const buttonSpy = vi.spyOn(buttonWorld.repos, 'getInventorySummary');
    await tapHomeButton(buttonWorld, GABRIEL, '📦INVENTARIO');
    expect(buttonSpy).toHaveBeenCalledTimes(1);
    const buttonText = buttonWorld.client.texts().at(-1) ?? '';
    expect(buttonText).toContain('Inventario MOCK');
    await buttonWorld.app.close();

    for (const phrase of ['¿qué tengo disponible?', 'CÓMO ESTÁ EL INVENTARIO', 'hay Netflix']) {
      const nlWorld = await createTwinWorld();
      const nlSpy = vi.spyOn(nlWorld.repos, 'getInventorySummary');
      await nlWorld.post(twinMessage(nlWorld.nextUpdateId(), GABRIEL, phrase));
      expect(nlWorld.interpreter.calls).toBe(0);
      expect(nlSpy).toHaveBeenCalledTimes(1);
      expect(nlWorld.client.texts().at(-1)).toBe(buttonText);
      await nlWorld.app.close();
    }
  });

  it('CAJA button ≡ NL (same placeholder, zero Gemini)', async () => {
    const buttonWorld = await createTwinWorld();
    await tapHomeButton(buttonWorld, GABRIEL, '💰CAJA');
    const buttonText = buttonWorld.client.texts().at(-1) ?? '';
    expect(buttonText).toContain('CAJA');
    await buttonWorld.app.close();

    for (const phrase of ['¿cómo está la caja?', 'QUÉ ENTRÓ HOY']) {
      const nlWorld = await createTwinWorld();
      await nlWorld.post(twinMessage(nlWorld.nextUpdateId(), GABRIEL, phrase));
      expect(nlWorld.interpreter.calls).toBe(0);
      expect(nlWorld.client.texts().at(-1)).toBe(buttonText);
      await nlWorld.app.close();
    }
  });

  it('MÁS button ≡ NL (same placeholder, zero Gemini)', async () => {
    const buttonWorld = await createTwinWorld();
    await tapHomeButton(buttonWorld, GABRIEL, '⋯MÁS');
    const buttonText = buttonWorld.client.texts().at(-1) ?? '';
    await buttonWorld.app.close();

    for (const phrase of ['¿qué más puedo hacer?', 'muéstrame otras opciones']) {
      const nlWorld = await createTwinWorld();
      await nlWorld.post(twinMessage(nlWorld.nextUpdateId(), GABRIEL, phrase));
      expect(nlWorld.interpreter.calls).toBe(0);
      expect(nlWorld.client.texts().at(-1)).toBe(buttonText);
      await nlWorld.app.close();
    }
  });
});

describe('twins: params preserved, read-vs-write, no redundant questions (webhook)', () => {
  it('"crea una operación de prueba de 5 meses" keeps months=5; "déjalo en 3" corrects to 3', async () => {
    const world = await createTwinWorld();
    await world.post(
      twinMessage(world.nextUpdateId(), GABRIEL, 'crea una operación de prueba de 5 meses'),
    );
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.months).toBe(5);
    expect(world.client.texts().at(-1)).toMatch(/confirma/i);
    await world.post(
      twinMessage(world.nextUpdateId(), GABRIEL, 'no mejor déjalo en 3 meses'),
    );
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.months).toBe(3);
    expect(world.client.texts().at(-1)).toContain('Borrador actualizado: 3 mes(es)');
    await world.app.close();
  });

  it('complete reads execute with no question; complete writes confirm with no re-ask', async () => {
    const world = await createTwinWorld();
    const draftSpy = vi.spyOn(world.drafts, 'create');
    await world.post(twinMessage(world.nextUpdateId(), GABRIEL, '¿qué se me venció?'));
    expect(world.client.texts().at(-1)).toContain('Vencidos MOCK');
    expect(draftSpy).not.toHaveBeenCalled();
    expect(world.client.texts().at(-1)).not.toMatch(/¿.*\?/);

    await world.post(
      twinMessage(world.nextUpdateId(), GABRIEL, 'crea una operación de prueba de 5 meses'),
    );
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toMatch(/confirma/i);
    expect(last).not.toMatch(/por cuántos meses/i);
    expect(world.client.findButton('✅Confirmar')).toBeDefined();
    await world.app.close();
  });

  it('sell/renew NL executes nothing (contract only, guarded UNKNOWN)', async () => {
    const world = await createTwinWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchAccounts');
    const draftSpy = vi.spyOn(world.drafts, 'create');
    await world.post(twinMessage(world.nextUpdateId(), GABRIEL, 'quiero renovar maxnet050'));
    expect(searchSpy).not.toHaveBeenCalled();
    expect(draftSpy).not.toHaveBeenCalled();
    expect(world.client.texts().at(-1)).toContain('No entendí');
    await world.app.close();
  });
});

describe('twins: topic guard first + phone matrix on REAL fixture numbers', () => {
  it('section NL from a foreign topic dies before parser/Gemini/tools', async () => {
    const topics = new Map<number, number>([
      [GABRIEL, THREAD_GABRIEL],
      [EDWARD, THREAD_EDWARD],
    ]);
    const world = await createTwinWorld(topics);
    const expiredSpy = vi.spyOn(world.repos, 'getExpiredAccounts');
    await world.post(
      twinMessage(world.nextUpdateId(), GABRIEL, '¿qué se me venció?', THREAD_EDWARD),
    );
    expect(world.interpreter.calls).toBe(0);
    expect(expiredSpy).not.toHaveBeenCalled();
    expect(world.interactions.snapshot()).toHaveLength(0);
    expect(world.client.texts().at(-1)).toMatch(/pertenece/i);
    await world.app.close();
  });

  it('VE number variants converge on Anny Tovar (store level)', async () => {
    const world = await createTwinWorld();
    for (const variant of [
      '4145460657',
      '0414-5460657',
      '0414 546 0657',
      '+58 414-5460657',
      '58 4145460657',
    ]) {
      const rows = await world.repos.searchAccounts(variant);
      expect(rows.map((row) => row.nombre)).toContain('Anny Tovar');
    }
    await world.app.close();
  });

  it('multi-number cells match either side in any format', async () => {
    const world = await createTwinWorld();
    for (const variant of ['4124086018', '+58 412-4086018', '0424-2039835', '+58 424-2039835']) {
      const rows = await world.repos.searchAccounts(variant);
      expect(rows.map((row) => row.nombre)).toContain('Gerardo Hernandez');
    }
    await world.app.close();
  });

  it('foreign fixture numbers match their international forms', async () => {
    const world = await createTwinWorld();
    for (const variant of ['18174487435', '+1 817-448-7435']) {
      const rows = await world.repos.searchAccounts(variant);
      expect(rows.map((row) => row.nombre)).toContain('Johnathan sobrino Dayana');
    }
    for (const variant of ['34674003172', '+34 674-003-172']) {
      const rows = await world.repos.searchAccounts(variant);
      expect(rows.map((row) => row.nombre)).toContain('Jesus Galvis');
    }
    await world.app.close();
  });

  it('international NL phone searches hit the webhook result (zero Gemini)', async () => {
    const world = await createTwinWorld();
    await world.post(twinMessage(world.nextUpdateId(), GABRIEL, 'busca el +58 414-5460657'));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('Anny Tovar');
    await world.post(twinMessage(world.nextUpdateId(), GABRIEL, 'revisa 0424-2039835'));
    expect(world.client.texts().at(-1)).toContain('Gerardo Hernandez');
    await world.app.close();
  });
});

/**
 * Slice B — NewSale webhook UX: single-card flow, ownership, topics
 * (tests 64–69 + entry/Volver).
 *
 * Worlds wire the additive `sale` deps (sale drafts + live MOCK store);
 * every world without them keeps legacy behavior (locked by the other
 * suites). Actor/thread ids are TEST-ONLY.
 */

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
import { InteractionStore } from '../src/interactions/interactions';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import { NewSaleDraftStore } from '../src/sale/newSaleDraft';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';

const GABRIEL = 1057242322;
const EDWARD = 941030473;
const GROUP_CHAT_ID = -1005550001;

const T_GABRIEL = 18;
const T_EDWARD = 19;
const T_ALERTS = 25;

const SECRET = 'sale-webhook-test-secret-long';
const FULL_COMBO =
  'vende un perfil de netflix para 4145460657 por 2 meses, pagó 8 USD por zelle, lo recibió Edward';

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  TELEGRAM_BOT_TOKEN: 'tok-test-secret',
  TELEGRAM_WEBHOOK_SECRET: SECRET,
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
  replyMarkup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
  };
  messageThreadId?: number;
  messageId?: number;
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

  edits(): Array<SentPayload & { messageId: number }> {
    return this.sent
      .filter((entry) => entry.kind === 'edit')
      .map((entry) => entry.payload as SentPayload & { messageId: number });
  }

  texts(): string[] {
    return this.sends().map((entry) => entry.text);
  }

  answers(): Array<{ callbackQueryId: string; text?: string }> {
    return this.sent
      .filter((entry) => entry.kind === 'answer')
      .map((entry) => entry.payload as { callbackQueryId: string; text?: string });
  }

  lastButtons(): Array<{ text: string; callback_data?: string; url?: string }> {
    const last = this.sends().at(-1);
    return last?.replyMarkup?.inline_keyboard.flat() ?? [];
  }

  findButton(label: string): string | undefined {
    for (const send of [...this.sends()].reverse()) {
      const found = send.replyMarkup?.inline_keyboard
        .flat()
        .find((button) => button.text === label);
      if (found?.callback_data !== undefined) {
        return found.callback_data;
      }
    }
    return undefined;
  }
}

interface SaleWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter;
  saleDrafts: NewSaleDraftStore;
  mockStore: MockStore;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<void>;
}

const MODE_B_TOPICS = new Map<number, number>([
  [GABRIEL, T_GABRIEL],
  [EDWARD, T_EDWARD],
]);

async function createSaleWorld(opts?: { topics?: Map<number, number> }): Promise<SaleWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-saleweb-'));
  const mockStore = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const reposStore = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'repos-state.json'),
  });
  const client = new StubTelegramClient();
  const interpreter = new StubIntentInterpreter();
  const saleDrafts = new NewSaleDraftStore();
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions: new SessionStore(),
    drafts: new DraftEngine(),
    interactions: new InteractionStore(),
    interpreter,
    repos: new MockAccountRepositories(reposStore),
    client,
    sale: { saleDrafts, mockStore },
    ...(opts?.topics !== undefined ? { operatorTopics: opts.topics } : {}),
    alertsTopicId: T_ALERTS,
  });
  let counter = 7000;
  return {
    app,
    client,
    interpreter,
    saleDrafts,
    mockStore,
    nextUpdateId: () => {
      counter += 1;
      return counter;
    },
    post: async (update: unknown) => {
      await app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': SECRET },
        payload: update,
      });
    },
  };
}

const NAMES: Record<number, string> = { [GABRIEL]: 'Gabriel', [EDWARD]: 'Edward' };

function saleMessage(updateId: number, actorId: number, text: string, threadId?: number): unknown {
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

function saleCallback(
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

describe('sale topics (64–69)', () => {
  it('(64) Mode B: sale NL in the own topic opens the sale card (zero Gemini)', async () => {
    const world = await createSaleWorld({ topics: MODE_B_TOPICS });
    await world.post(
      saleMessage(world.nextUpdateId(), GABRIEL, 'quiero vender un perfil de netflix', T_GABRIEL),
    );
    expect(world.interpreter.calls).toBe(0);
    // Part B: deduped batch card — the phone bullet keeps the wording, capitalized.
    expect(world.client.texts().at(-1)).toContain('Teléfono');
    expect(
      world.saleDrafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL }),
    ).not.toBeUndefined();
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });

  it('(65) Mode B: sale NL in a foreign topic is rejected (nothing executes)', async () => {
    const world = await createSaleWorld({ topics: MODE_B_TOPICS });
    // Edward touches his topic first so the owner label resolves by profile.
    await world.post(saleMessage(world.nextUpdateId(), EDWARD, '/topicid', T_EDWARD));
    await world.post(
      saleMessage(world.nextUpdateId(), GABRIEL, 'quiero vender un perfil de netflix', T_EDWARD),
    );
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Edward. Usa tu topic 👤 Gabriel.',
    );
    expect(world.interpreter.calls).toBe(0);
    expect(
      world.saleDrafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL }),
    ).toBeUndefined();
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });

  it('(66) Mode B: sale NL in General is guided away (non-operational)', async () => {
    const world = await createSaleWorld({ topics: MODE_B_TOPICS });
    await world.post(saleMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    expect(world.client.texts().at(-1)).toContain('usa tu topic de trabajo');
    expect(world.interpreter.calls).toBe(0);
    expect(
      world.saleDrafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL }),
    ).toBeUndefined();
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });

  it('(67) Mode B: sale confirm tap in Alertas is blocked (never operational)', async () => {
    const world = await createSaleWorld({ topics: MODE_B_TOPICS });
    await world.post(
      saleCallback(world.nextUpdateId(), GABRIEL, 'v1:ok:deadbeef', T_ALERTS),
    );
    expect(world.client.texts().at(-1)).toContain('solo para alertas');
    expect(
      world.saleDrafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL }),
    ).toBeUndefined();
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });

  it('(68) cross-actor Confirm tap is rejected; owner confirm executes exactly once', async () => {
    const world = await createSaleWorld();
    await world.post(saleMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    expect(world.client.texts().at(-1)).toContain('VENTA NUEVA');
    const confirmData = world.client.findButton('✅Confirmar');
    expect(confirmData).toBeDefined();

    await world.post(saleCallback(world.nextUpdateId(), EDWARD, confirmData as string));
    expect(
      world.client.answers().some((answer) => answer.text === 'Esta acción pertenece a Gabriel.'),
    ).toBe(true);
    expect(world.mockStore.saleOperations).toHaveLength(0);

    await world.post(saleCallback(world.nextUpdateId(), GABRIEL, confirmData as string));
    expect(world.mockStore.saleOperations).toHaveLength(1);
    // HOTFIX 2: terminal freeze (in-place edit) + fresh Home below.
    expect(world.client.texts()).toContainEqual(
      expect.stringContaining('✅ VENTA CONFIRMADA'),
    );
    const last = world.client.sends().at(-1);
    expect(last?.text).toContain('Vokath');
    await world.app.close();
  });

  it('(69) single-card: OPERAR → Venta nueva → summary → Confirm edits the SAME card + WhatsApp', async () => {
    const world = await createSaleWorld();
    await world.post(saleMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const operar = world.client.findButton('⚡OPERAR');
    expect(operar).toBeDefined();
    await world.post(saleCallback(world.nextUpdateId(), GABRIEL, operar as string));

    const entry = world.client.texts().at(-1) ?? '';
    expect(entry).toContain('Venta nueva');
    expect(entry).not.toMatch(/Renovación|Bolsa|Cierre/);
    const saleNew = world.client.findButton('🛒 Venta nueva');
    expect(saleNew).toBeDefined();
    await world.post(saleCallback(world.nextUpdateId(), GABRIEL, saleNew as string));
    expect(world.client.texts().at(-1)).toContain('¿Qué servicio vendemos');

    await world.post(saleMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const summary = world.client.texts().at(-1) ?? '';
    expect(summary).toContain('VENTA NUEVA');
    expect(summary).not.toContain('Contraseña');
    expect(summary).not.toContain('juan8727');
    expect(summary).not.toContain('wa.me');
    expect(world.interpreter.calls).toBe(0);

    const confirmData = world.client.findButton('✅Confirmar');
    expect(confirmData).toBeDefined();
    const sendsBefore = world.client.sends().length;
    await world.post(saleCallback(world.nextUpdateId(), GABRIEL, confirmData as string));

    const tail = world.client.sends().slice(sendsBefore);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.every((send) => send.text.includes('Operador: Gabriel'))).toBe(true);
    // HOTFIX 2: the confirmed result renders on the frozen card (edit);
    // the sends tail carries the fresh Home below.
    const events = world.client.texts();
    expect(events).toContainEqual(expect.stringContaining('✅ VENTA CONFIRMADA'));
    const confirmedEdit = world.client.edits().at(-1);
    expect(confirmedEdit?.text).toContain('✅ VENTA CONFIRMADA');
    expect(confirmedEdit?.text).toContain('🔐 DATOS DE ACCESO');
    expect(confirmedEdit?.text).toContain('🔒 PIN: 0657');
    expect(confirmedEdit?.text).toContain('💬 WhatsApp preparado.');
    const whatsapp = confirmedEdit?.replyMarkup?.inline_keyboard
      .flat()
      .find((button) => button.text === '💬 Abrir WhatsApp');
    expect(whatsapp?.url).toMatch(/^https:\/\/wa\.me\/584145460657\?text=/);
    const confirmed = tail.at(-1);
    expect(confirmed?.text).toContain('Vokath');
    expect(world.mockStore.saleOperations).toHaveLength(1);
    await world.app.close();
  });

  it('(69b) Volver from the sale entry returns to the explicit Home root', async () => {
    const world = await createSaleWorld();
    await world.post(saleMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const operar = world.client.findButton('⚡OPERAR');
    await world.post(saleCallback(world.nextUpdateId(), GABRIEL, operar as string));
    const back = world.client.findButton('←Volver');
    expect(back).toBeDefined();
    await world.post(saleCallback(world.nextUpdateId(), GABRIEL, back as string));
    expect(world.client.texts().at(-1)).toContain('🏠 Vokath');
    expect(
      world.saleDrafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL }),
    ).toBeUndefined();
    await world.app.close();
  });
});

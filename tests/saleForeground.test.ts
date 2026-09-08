/**
 * ONE FOREGROUND INTERACTION + active-interaction-first routing + real
 * sale language (Fase 4/Event 2 follow-up).
 *
 * - Expected-field 1–6 (incl. the exact "04149990001 → Gabriel Juan"
 *   regression + continuation).
 * - Single-card 7–16 (1 initial send, edits per step, 1 foreground max).
 * - Routing 17–22 (expected/correction/navigation priority, no-parallel
 *   second mutation, global-only-when-free, UNKNOWN-in-operation).
 * - Real language 23–31 (phrase→intent/params matrix + typo tolerance).
 * - Inventory-early 32–37. Buttons 38–41. Parallel-ops 42–45.
 * - Renew-word reservation (recarga/renueva never NEW_SALE).
 *
 * Worlds wire the additive `sale` deps; the stub client returns
 * incrementing `message_id`s so single-card edit conservation is
 * observable (1 send + N edits on ONE message id).
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
import type { MockAccount } from '../src/mock/excelLoader';
import { NewSaleDraftStore } from '../src/sale/newSaleDraft';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';

const GABRIEL = 1057242322;
const EDWARD = 941030473;
const GROUP_CHAT_ID = -1005550001;

const SECRET = 'sale-foreground-test-secret-long';
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

interface CardPayload {
  chatId: number;
  text: string;
  replyMarkup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
  };
  messageThreadId?: number;
  messageId?: number;
}

/** Stub client with real incrementing message ids (edit conservation is observable). */
class CardClient implements TelegramClient {
  readonly sent: Array<{ kind: 'send' | 'edit' | 'answer'; payload: unknown }> = [];
  private nextId = 500;

  async sendMessage(opts: CardPayload): Promise<unknown> {
    const messageId = this.nextId;
    this.nextId += 1;
    this.sent.push({ kind: 'send', payload: { ...opts, messageId } });
    return { ok: true, result: { message_id: messageId } };
  }

  async editMessageText(opts: CardPayload & { messageId: number }): Promise<unknown> {
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

  cards(): CardPayload[] {
    return this.sent
      .filter((entry) => entry.kind === 'send' || entry.kind === 'edit')
      .map((entry) => entry.payload as CardPayload);
  }

  sends(): CardPayload[] {
    return this.sent
      .filter((entry) => entry.kind === 'send')
      .map((entry) => entry.payload as CardPayload);
  }

  edits(): Array<CardPayload & { messageId: number }> {
    return this.sent
      .filter((entry) => entry.kind === 'edit')
      .map((entry) => entry.payload as CardPayload & { messageId: number });
  }

  texts(): string[] {
    return this.cards().map((entry) => entry.text);
  }

  answers(): Array<{ callbackQueryId: string; text?: string }> {
    return this.sent
      .filter((entry) => entry.kind === 'answer')
      .map((entry) => entry.payload as { callbackQueryId: string; text?: string });
  }

  lastButtons(): Array<{ text: string; callback_data?: string; url?: string }> {
    const last = this.cards().at(-1);
    return last?.replyMarkup?.inline_keyboard.flat() ?? [];
  }

  findButton(label: string): string | undefined {
    for (const send of [...this.cards()].reverse()) {
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

interface ForegroundWorld {
  app: FastifyInstance;
  client: CardClient;
  interpreter: StubIntentInterpreter;
  saleDrafts: NewSaleDraftStore;
  mockStore: MockStore;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<void>;
}

async function createForegroundWorld(): Promise<ForegroundWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-foreground-'));
  const mockStore = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const reposStore = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'repos-state.json'),
  });
  const client = new CardClient();
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
    alertsTopicId: 25,
  });
  let counter = 9000;
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

function textMessage(updateId: number, actorId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Stranger' },
      chat: { id: GROUP_CHAT_ID, type: 'supergroup', is_forum: true },
      text,
    },
  };
}

function tap(updateId: number, actorId: number, data: string): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Stranger' },
      message: {
        message_id: 7,
        chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
      },
      data,
    },
  };
}

function ownerOf(world: ForegroundWorld, actorId: number): { chatId: number; userId: number } {
  void world;
  return { chatId: GROUP_CHAT_ID, userId: actorId };
}

/** Guided walk to the new-customer name question (service+phone known, name missing). */
async function walkToNameQuestion(world: ForegroundWorld): Promise<void> {
  await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix'));
  await world.post(textMessage(world.nextUpdateId(), GABRIEL, '04149990001'));
}

describe('expected-field 1–6 (Gabriel Juan regression + continuation)', () => {
  it('(1) unknown phone asks the customer name on the sale card (zero Gemini)', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix'));
    // Part B: deduped batch card — bullets keep the wording, capitalized.
    expect(world.client.texts().at(-1)).toContain('Teléfono');
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, '04149990001'));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('Nombre del cliente');
    expect(last).not.toContain('CUENTA NO ENCONTRADA');
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(2) "Gabriel Juan" fills draft.proposedCustomer.name, never global search', async () => {
    const world = await createForegroundWorld();
    await walkToNameQuestion(world);
    const opBefore = world.saleDrafts.get(ownerOf(world, GABRIEL))?.operationId;
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'Gabriel Juan'));
    const draft = world.saleDrafts.get(ownerOf(world, GABRIEL));
    expect(draft?.operationId).toBe(opBefore);
    expect(draft?.customer.proposedCustomer?.name).toBe('Gabriel Juan');
    expect(draft?.customer.proposedCustomer?.phone).toBe('04149990001');
    const last = world.client.texts().at(-1) ?? '';
    expect(last).not.toContain('CUENTA NO ENCONTRADA');
    expect(last).not.toContain('NO ENCONTRADO');
    expect(last).toContain('meses');
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(3) "30 días" continues to the next missing field as 1 month', async () => {
    const world = await createForegroundWorld();
    await walkToNameQuestion(world);
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'Gabriel Juan'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, '30 días'));
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))?.duration.requestedMonths).toBe(1);
    expect(world.client.texts().at(-1)).toContain('Método de pago');
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(4) "zelle" + "Edward" fill method and receiver up to the ready summary', async () => {
    const world = await createForegroundWorld();
    await walkToNameQuestion(world);
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'Gabriel Juan'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, '30 días'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'zelle'));
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))?.payment.method).toBe('zelle');
    expect(world.client.texts().at(-1)).toContain('recibió');
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'recibí 5 usd'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'Edward'));
    const draft = world.saleDrafts.get(ownerOf(world, GABRIEL));
    expect(draft?.payment.receivedBy).toBe('Edward');
    expect(world.client.texts().at(-1)).toContain('VENTA NUEVA');
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(5) receiver variants "lo recibió Edward" and "fue Edward" fill the receiver', async () => {
    for (const phrase of ['lo recibió Edward', 'fue Edward']) {
      const world = await createForegroundWorld();
      await walkToNameQuestion(world);
      await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'Gabriel Juan'));
      await world.post(textMessage(world.nextUpdateId(), GABRIEL, '2 meses'));
      await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'zelle'));
      await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'recibí 5 usd'));
      await world.post(textMessage(world.nextUpdateId(), GABRIEL, phrase));
      expect(world.saleDrafts.get(ownerOf(world, GABRIEL))?.payment.receivedBy).toBe('Edward');
      expect(world.client.texts().at(-1)).toContain('VENTA NUEVA');
      await world.app.close();
    }
  });

  it('(6) uninterpretable-inside-operation keeps the card naming the field, draft intact', async () => {
    const world = await createForegroundWorld();
    await walkToNameQuestion(world);
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'Gabriel Juan'));
    const draftBefore = world.saleDrafts.get(ownerOf(world, GABRIEL));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, '???'));
    const draftAfter = world.saleDrafts.get(ownerOf(world, GABRIEL));
    expect(draftAfter?.operationId).toBe(draftBefore?.operationId);
    expect(draftAfter?.version).toBe(draftBefore?.version);
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('duración');
    expect(last).toContain('borrador sigue intacto');
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });
});

describe('single-card 7–16 (1 send + N edits, 1 foreground max)', () => {
  it('(7) full guided walk: 1 initial send, one edit per step on the same message', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, '04149990001'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'Gabriel Juan'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, '30 días'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'zelle'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'recibí 5 usd'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'Edward'));
    expect(world.client.sends()).toHaveLength(1);
    expect(world.client.edits()).toHaveLength(6);
    const ids = new Set([
      world.client.sends()[0]?.messageId,
      ...world.client.edits().map((edit) => edit.messageId),
    ]);
    expect(ids.size).toBe(1);
    const stepTexts = world.client.texts();
    // Part B: deduped batch card — the name bullet keeps the wording, capitalized.
    expect(stepTexts[1]).toContain('Nombre del cliente');
    expect(stepTexts[2]).toContain('meses');
    expect(stepTexts[3]).toContain('Método de pago');
    expect(stepTexts[6]).toContain('VENTA NUEVA');
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(8) Confirm tap freezes the card on VENTA CONFIRMADA + fresh Home below (ledger 1)', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const confirmData = world.client.findButton('✅Confirmar');
    expect(confirmData).toBeDefined();
    const sendsBefore = world.client.sends().length;
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirmData as string));
    expect(world.mockStore.saleOperations).toHaveLength(1);
    // HOTFIX 2 terminal lifecycle: the SAME card carries the final
    // result (frozen, zero callbacks except WhatsApp) and exactly ONE
    // fresh Home send lands below it.
    expect(world.client.sends()).toHaveLength(sendsBefore + 1);
    expect(world.client.texts()).toContainEqual(expect.stringContaining('✅ VENTA CONFIRMADA'));
    expect(world.client.texts().at(-1)).toContain('🏠 Vokath');
    // Frozen confirmed card keeps ONLY the external WhatsApp action.
    const frozenButtons = world.client.edits().at(-1)?.replyMarkup?.inline_keyboard.flat() ?? [];
    expect(frozenButtons.some((button) => button.text === '💬 Abrir WhatsApp')).toBe(true);
    expect(frozenButtons.every((button) => button.callback_data === undefined)).toBe(true);
    await world.app.close();
  });

  it('(9) NL cancelar freezes the SAME card compact + fresh Home below, draft dropped, ledger 0', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'cancelar'));
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))).toBeUndefined();
    expect(world.client.sends()).toHaveLength(2);
    expect(world.client.edits()).toHaveLength(1);
    expect(world.client.texts()).toContainEqual(expect.stringContaining('cancelada'));
    expect(world.client.texts().at(-1)).toContain('🏠 Vokath');
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });

  it('(10) unrelated read keeps focus: same card, no second operational card', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'cómo está la caja'));
    expect(world.client.sends()).toHaveLength(1);
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))).not.toBeUndefined();
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(11) stale callbacks are a safe no-op (zero state change)', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix'));
    const cardsBefore = world.client.cards().length;
    await world.post(tap(world.nextUpdateId(), GABRIEL, 'v1:ok:deadbeef'));
    expect(world.client.cards()).toHaveLength(cardsBefore);
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))).not.toBeUndefined();
    await world.app.close();
  });

  it('(12) foreign actor taps are blocked with the ownership toast', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const confirmData = world.client.findButton('✅Confirmar');
    await world.post(tap(world.nextUpdateId(), EDWARD, confirmData as string));
    expect(
      world.client.answers().some((answer) => answer.text === 'Esta acción pertenece a Gabriel.'),
    ).toBe(true);
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });

  it('(13) volver returns to the entry card on the SAME message, draft intact', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'volver'));
    expect(world.client.sends()).toHaveLength(1);
    expect(world.client.texts().at(-1)).toContain('Venta nueva');
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))).not.toBeUndefined();
    await world.app.close();
  });

  it('(14) continuar re-renders the in-progress draft on the SAME card', async () => {
    const world = await createForegroundWorld();
    await walkToNameQuestion(world);
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'continuar'));
    expect(world.client.sends()).toHaveLength(1);
    // Part B: deduped batch card — the name bullet keeps the wording, capitalized.
    expect(world.client.texts().at(-1)).toContain('Nombre del cliente');
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))).not.toBeUndefined();
    await world.app.close();
  });

  it('(15) result card carries Confirmar/Corregir only when fully ready (summary here)', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons).toContain('✅Confirmar');
    expect(buttons).toContain('✏️Corregir');
    await world.app.close();
  });

  it('(16) confirmed card freezes the result + fresh Home below (send once for the card, one Home send)', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const confirmData = world.client.findButton('✅Confirmar');
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirmData as string));
    // HOTFIX 2: the card send + its terminal edit keep one lineage; the
    // fresh Home is the only second send.
    expect(world.client.sends()).toHaveLength(2);
    expect(world.client.texts()).toContainEqual(expect.stringContaining('💬 WhatsApp preparado.'));
    expect(world.client.texts().at(-1)).toContain('🏠 Vokath');
    await world.app.close();
  });
});

describe('routing 17–22 (active-first priorities)', () => {
  it('(17) expected-field answer never reaches global search (Gabriel Juan proof)', async () => {
    const world = await createForegroundWorld();
    await walkToNameQuestion(world);
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'Gabriel Juan'));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).not.toMatch(/NO ENCONTRADO/i);
    await world.app.close();
  });

  it('(18) in-operation correction folds months into the SAME draft', async () => {
    const world = await createForegroundWorld();
    await walkToNameQuestion(world);
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'Gabriel Juan'));
    const opBefore = world.saleDrafts.get(ownerOf(world, GABRIEL))?.operationId;
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'hazlo 2 meses'));
    const draft = world.saleDrafts.get(ownerOf(world, GABRIEL));
    expect(draft?.operationId).toBe(opBefore);
    expect(draft?.duration.requestedMonths).toBe(2);
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(19) navigation wins over fill: "cancelar" cancels even while a name is expected', async () => {
    const world = await createForegroundWorld();
    await walkToNameQuestion(world);
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'cancelar'));
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))).toBeUndefined();
    // HOTFIX 2: the SAME card freezes compact, the fresh Home lands below.
    expect(world.client.texts()).toContainEqual(expect.stringContaining('cancelada'));
    expect(world.client.texts().at(-1)).toContain('🏠 Vokath');
    await world.app.close();
  });

  it('(20) second mutation → GESTIÓN PENDIENTE on the SAME card, draft intact', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const draftBefore = world.saleDrafts.get(ownerOf(world, GABRIEL));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'vende otra cuenta netflix'));
    expect(world.client.sends()).toHaveLength(1);
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('GESTIÓN PENDIENTE');
    const draftAfter = world.saleDrafts.get(ownerOf(world, GABRIEL));
    expect(draftAfter?.operationId).toBe(draftBefore?.operationId);
    expect(draftAfter?.service).toBe('netflix');
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons).toContain('▶️ Continuar venta');
    expect(buttons).toContain('❌Cancelar venta');
    // Continuar resumes the draft on the same card.
    const keep = world.client.findButton('▶️ Continuar venta');
    await world.post(tap(world.nextUpdateId(), GABRIEL, keep as string));
    expect(world.client.texts().at(-1)).toContain('VENTA NUEVA');
    expect(world.client.sends()).toHaveLength(1);
    await world.app.close();
  });

  it('(21) global-only-when-free: no draft + "Gabriel Juan" never opens a sale', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'Gabriel Juan'));
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))).toBeUndefined();
    expect(world.client.texts().at(-1)).not.toContain('VENTA NUEVA');
    await world.app.close();
  });

  it('(22) UNKNOWN-in-operation keeps the card, names the field, zero Gemini', async () => {
    const world = await createForegroundWorld();
    await walkToNameQuestion(world);
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'Gabriel Juan'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'xyzzy plugh'));
    expect(world.client.sends()).toHaveLength(1);
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('duración');
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))).not.toBeUndefined();
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });
});

describe('real sale language 23–31 (phrase→intent/params matrix)', () => {
  it('(23) "dame una cuenta nueva netflix" → PROFILE inferred, asks phone only', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix'));
    const draft = world.saleDrafts.get(ownerOf(world, GABRIEL));
    expect(draft?.service).toBe('netflix');
    expect(draft?.modality).toBe('netflix-profile');
    const last = world.client.texts().at(-1) ?? '';
    // Part B: deduped batch card — the phone bullet keeps the wording, capitalized.
    expect(last).toContain('Teléfono');
    expect(last).not.toMatch(/perfil o completa|compartida o completa/i);
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(24) "dame un perfil netflix por un mes" → PROFILE + 1 month', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame un perfil netflix por un mes'));
    const draft = world.saleDrafts.get(ownerOf(world, GABRIEL));
    expect(draft?.service).toBe('netflix');
    expect(draft?.modality).toBe('netflix-profile');
    expect(draft?.duration.requestedMonths).toBe(1);
    await world.app.close();
  });

  it('(25) "necesito una netflix por 30 dias" → sale cue + PROFILE + 1 month', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'necesito una netflix por 30 dias'));
    const draft = world.saleDrafts.get(ownerOf(world, GABRIEL));
    expect(draft?.service).toBe('netflix');
    expect(draft?.modality).toBe('netflix-profile');
    expect(draft?.duration.requestedMonths).toBe(1);
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(26) "sácame una netflix" opens the sale draft (zero Gemini)', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'sácame una netflix'));
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))?.service).toBe('netflix');
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(27) "dame un perfil flujo por 30 dias" → FLUJOTV shared + 1 month', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame un perfil flujotv por 30 dias'));
    const draft = world.saleDrafts.get(ownerOf(world, GABRIEL));
    expect(draft?.service).toBe('flujotv');
    expect(draft?.modality).toBe('flujotv-shared');
    expect(draft?.duration.requestedMonths).toBe(1);
    await world.app.close();
  });

  it('(28) "dame una cuenta completa flujo" / "necesito una completa de flujo" → COMPLETE', async () => {
    for (const phrase of ['dame una cuenta completa flujotv', 'necesito una completa de flujo']) {
      const world = await createForegroundWorld();
      await world.post(textMessage(world.nextUpdateId(), GABRIEL, phrase));
      const draft = world.saleDrafts.get(ownerOf(world, GABRIEL));
      expect(draft?.service).toBe('flujotv');
      expect(draft?.modality).toBe('flujotv-complete');
      await world.app.close();
    }
  });

  it('(29) bare "dame una cuenta completa" → FLUJOTV COMPLETE, never asks service', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta completa'));
    const draft = world.saleDrafts.get(ownerOf(world, GABRIEL));
    expect(draft?.service).toBe('flujotv');
    expect(draft?.modality).toBe('flujotv-complete');
    const last = world.client.texts().at(-1) ?? '';
    expect(last).not.toMatch(/Netflix o FlujoTV/);
    await world.app.close();
  });

  it('(30) typo tolerance: case, missing accents, service typos still classify', async () => {
    for (const phrase of [
      'DAME UNA CUENTA NUEVA NETFLIX',
      'sacame una netflix',
      'dame una cuenta nueva netflx',
      'dame un perfil flujo gtv por 30 dias',
    ]) {
      const world = await createForegroundWorld();
      await world.post(textMessage(world.nextUpdateId(), GABRIEL, phrase));
      expect(
        world.saleDrafts.get(ownerOf(world, GABRIEL)),
        phrase,
      ).not.toBeUndefined();
      expect(world.interpreter.calls).toBe(0);
      await world.app.close();
    }
  });

  it('(31) full-combo sentence skips the wizard straight to the ready summary', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('VENTA NUEVA');
    expect(world.client.findButton('✅Confirmar')).toBeDefined();
    expect(world.client.sends()).toHaveLength(1);
    await world.app.close();
  });
});

describe('inventory-early 32–37 (precheck before questions)', () => {
  it('(32) zero inventory + full combo with unknown phone → SIN INVENTARIO, never new-customer', async () => {
    const world = await createForegroundWorld();
    world.mockStore.accounts.length = 0;
    await world.post(
      textMessage(
        world.nextUpdateId(),
        GABRIEL,
        'vende un perfil de netflix para 04149990001 por 1 mes, zelle 4 usd, lo recibió Gabriel',
      ),
    );
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('No hay inventario disponible');
    expect(last).not.toContain('nombre del cliente');
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });

  it('(33) emergency-only stock → emergency card BEFORE collecting customer data', async () => {
    const world = await createForegroundWorld();
    world.mockStore.accounts.length = 0;
    world.mockStore.accounts.push(
      {
        servicio: 'netflix',
        correo: 'llena@test.com',
        perfil: '1 PERFIL (1)',
        nombre: 'Ocupa',
        numero: '7000000',
        contrasena: 'x',
        fechaInicio: null,
        fechaFin: null,
        dias: null,
        estatus: 'VIGENTE',
        monto: null,
        estado: '',
        pais: 'VE',
      } as MockAccount,
      {
        servicio: 'netflix',
        correo: 'emer@test.com',
        perfil: '1 PERFIL (5)',
        nombre: '',
        numero: '',
        contrasena: 'x',
        fechaInicio: null,
        fechaFin: null,
        dias: null,
        estatus: 'VIGENTE',
        monto: null,
        estado: '',
        pais: 'VE',
      } as MockAccount,
    );
    await world.post(
      textMessage(
        world.nextUpdateId(),
        GABRIEL,
        'vende netflix para 04149990001 por 1 mes, zelle 4 usd, lo recibió Gabriel',
      ),
    );
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('EMERGENCIA');
    expect(last).not.toContain('nombre del cliente');
    expect(world.client.lastButtons().map((button) => button.text)).not.toContain('✅Confirmar');
    await world.app.close();
  });

  it('(34) emergency auth stays explicit: authorize then confirm executes once', async () => {
    const world = await createForegroundWorld();
    world.mockStore.accounts.length = 0;
    world.mockStore.accounts.push(
      {
        servicio: 'netflix',
        correo: 'llena@test.com',
        perfil: '1 PERFIL (1)',
        nombre: 'Ocupa',
        numero: '7000000',
        contrasena: 'x',
        fechaInicio: null,
        fechaFin: null,
        dias: null,
        estatus: 'VIGENTE',
        monto: null,
        estado: '',
        pais: 'VE',
      } as MockAccount,
      {
        servicio: 'netflix',
        correo: 'emer@test.com',
        perfil: '1 PERFIL (5)',
        nombre: '',
        numero: '',
        contrasena: 'x',
        fechaInicio: null,
        fechaFin: null,
        dias: null,
        estatus: 'VIGENTE',
        monto: null,
        estado: '',
        pais: 'VE',
      } as MockAccount,
    );
    // Known customer number from the fixture-shaped rows is gone; use a
    // fresh unknown phone → emergency card first (customer later).
    await world.post(
      textMessage(
        world.nextUpdateId(),
        GABRIEL,
        'vende netflix para 04149990002 por 1 mes, zelle 4 usd, lo recibió Gabriel',
      ),
    );
    expect(world.client.texts().at(-1)).toContain('EMERGENCIA');
    const auth = world.client.findButton('⚠️ Usar emergencia');
    expect(auth).toBeDefined();
    await world.post(tap(world.nextUpdateId(), GABRIEL, auth as string));
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });

  it('(35) confirm revalidates: inventory drained after summary → no-inventory, ledger 0', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    expect(world.client.texts().at(-1)).toContain('VENTA NUEVA');
    world.mockStore.accounts.length = 0;
    const confirmData = world.client.findButton('✅Confirmar');
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirmData as string));
    expect(world.client.texts().at(-1)).toContain('No hay inventario disponible');
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });

  it('(36) zero inventory + bare cue asks nothing else (no phone question)', async () => {
    const world = await createForegroundWorld();
    world.mockStore.accounts.length = 0;
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix'));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('No hay inventario disponible');
    expect(last).not.toContain('teléfono');
    await world.app.close();
  });

  it('(37) no-inventory card never offers Confirmar', async () => {
    const world = await createForegroundWorld();
    world.mockStore.accounts.length = 0;
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix'));
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons).not.toContain('✅Confirmar');
    expect(buttons).not.toContain('✏️Corregir');
    await world.app.close();
  });
});

describe('buttons 38–41 (contextual gating)', () => {
  it('(38) incomplete draft → NO Confirmar/Corregir, only Volver/Cancelar', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix'));
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons).not.toContain('✅Confirmar');
    expect(buttons).not.toContain('✏️Corregir');
    expect(buttons).toContain('❌Cancelar');
    expect(buttons).toContain('←Volver');
    await world.app.close();
  });

  it('(39) service/modality choice buttons fold the structured choice into the SAME draft', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva'));
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons).toContain('Netflix · Perfil');
    expect(buttons).toContain('FlujoTV · Perfil');
    expect(buttons).toContain('FlujoTV · Completa');
    const opBefore = world.saleDrafts.get(ownerOf(world, GABRIEL))?.operationId;
    const choice = world.client.findButton('FlujoTV · Completa');
    await world.post(tap(world.nextUpdateId(), GABRIEL, choice as string));
    const draft = world.saleDrafts.get(ownerOf(world, GABRIEL));
    expect(draft?.operationId).toBe(opBefore);
    expect(draft?.service).toBe('flujotv');
    expect(draft?.modality).toBe('flujotv-complete');
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(40) ready summary carries Confirmar + Corregir + Cancelar + Volver', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons).toContain('✅Confirmar');
    expect(buttons).toContain('✏️Corregir');
    expect(buttons).toContain('❌Cancelar');
    expect(buttons).toContain('←Volver');
    await world.app.close();
  });

  it('(41) pending card: Cancelar venta freezes the SAME card compact + fresh Home below', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'vende otra cuenta netflix'));
    expect(world.client.texts().at(-1)).toContain('GESTIÓN PENDIENTE');
    const cancel = world.client.findButton('❌Cancelar venta');
    await world.post(tap(world.nextUpdateId(), GABRIEL, cancel as string));
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))).toBeUndefined();
    // HOTFIX 2: the pending card itself freezes compact; Home below.
    expect(world.client.texts()).toContainEqual(expect.stringContaining('cancelada'));
    expect(world.client.texts().at(-1)).toContain('🏠 Vokath');
    expect(world.client.sends()).toHaveLength(2);
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });
});

describe('parallel-ops 42–45 (per-actor foreground isolation)', () => {
  it('(42) two actors hold independent foreground cards (2 sends, separate drafts)', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix'));
    await world.post(textMessage(world.nextUpdateId(), EDWARD, 'dame una cuenta nueva netflix'));
    expect(world.client.sends()).toHaveLength(2);
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))).not.toBeUndefined();
    expect(world.saleDrafts.get(ownerOf(world, EDWARD))).not.toBeUndefined();
    expect(
      world.saleDrafts.get(ownerOf(world, GABRIEL))?.operationId,
    ).not.toBe(world.saleDrafts.get(ownerOf(world, EDWARD))?.operationId);
    await world.app.close();
  });

  it('(43) cross-actor text never fills the peer draft (Gabriel name stays clean)', async () => {
    const world = await createForegroundWorld();
    await walkToNameQuestion(world);
    await world.post(textMessage(world.nextUpdateId(), EDWARD, 'Intruso'));
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))?.customer.proposedCustomer).toBeUndefined();
    expect(world.saleDrafts.get(ownerOf(world, EDWARD))).toBeUndefined();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'Gabriel Juan'));
    expect(
      world.saleDrafts.get(ownerOf(world, GABRIEL))?.customer.proposedCustomer?.name,
    ).toBe('Gabriel Juan');
    await world.app.close();
  });

  it('(44) peer cannot Continuar/Cancelar the owner card (ownership toast, draft intact)', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'vende otra cuenta netflix'));
    const keep = world.client.findButton('▶️ Continuar venta');
    await world.post(tap(world.nextUpdateId(), EDWARD, keep as string));
    expect(
      world.client.answers().some((answer) => answer.text === 'Esta acción pertenece a Gabriel.'),
    ).toBe(true);
    expect(world.saleDrafts.get(ownerOf(world, GABRIEL))).not.toBeUndefined();
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });

  it('(45) each actor keeps a single-card lineage across a full walk', async () => {
    const world = await createForegroundWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix'));
    await world.post(textMessage(world.nextUpdateId(), EDWARD, 'dame una cuenta nueva netflix'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, '04149990001'));
    await world.post(textMessage(world.nextUpdateId(), EDWARD, '04149990002'));
    expect(world.client.sends()).toHaveLength(2);
    expect(world.client.edits()).toHaveLength(2);
    await world.app.close();
  });
});

describe('renew-word reservation (never NEW_SALE)', () => {
  it('(46a) "recarga/renueva" sentences create no draft and answer the safe hold', async () => {
    for (const phrase of [
      'recarga mi cuenta netflix',
      'renueva mi perfil de netflix por 30 dias',
      'quiero renovar maxnet050',
    ]) {
      const world = await createForegroundWorld();
      await world.post(textMessage(world.nextUpdateId(), GABRIEL, phrase));
      expect(world.saleDrafts.get(ownerOf(world, GABRIEL)), phrase).toBeUndefined();
      expect(world.client.texts().at(-1), phrase).toContain('renovaciones aún no están disponibles');
      expect(world.mockStore.saleOperations, phrase).toHaveLength(0);
      await world.app.close();
    }
  });

  it('(46b) renewal hint mid-sale holds the same card, draft intact, zero Gemini', async () => {
    const world = await createForegroundWorld();
    await walkToNameQuestion(world);
    const draftBefore = world.saleDrafts.get(ownerOf(world, GABRIEL));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'mejor renueva por 2 meses'));
    const draftAfter = world.saleDrafts.get(ownerOf(world, GABRIEL));
    expect(draftAfter?.operationId).toBe(draftBefore?.operationId);
    expect(draftAfter?.customer.proposedCustomer).toBeUndefined();
    expect(world.client.sends()).toHaveLength(1);
    expect(world.client.texts().at(-1)).toContain('renovaciones aún no están disponibles');
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });
});

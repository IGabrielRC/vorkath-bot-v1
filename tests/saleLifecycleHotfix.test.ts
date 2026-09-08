/**
 * HOTFIX 2 — terminal card lifecycle: ONE ACTIVE CARD, refined
 * (webhook level unless noted).
 *
 * - (16) single ACTIVE card: when a new foreground card activates, the
 *   prior Home/operational card loses its keyboard (old buttons are not
 *   tappable).
 * - (17–18) terminal states freeze (CONFIRMED final result + WhatsApp
 *   preserved; CANCELLED compact) and a fresh Home lands BELOW with a
 *   different messageId.
 * - (19) new operations never edit the terminal card.
 * - (20–22) stale callbacks (Confirm/Cancel/Volver on frozen cards) are
 *   safe no-ops with the brief "gestión terminada" note; Back never
 *   resurrects; WhatsApp URLs still work (no callback involved).
 * - (23) new operations start clean (new operationId, no inherited
 *   customer/location).
 * - (24) actor isolation across terminal boundaries.
 * - (25) card-lost recovery: a deleted card re-renders into a NEW
 *   replacement card; the draft survives.
 * - (26) stale-operation taps refresh the current card, mutate nothing.
 * - (27) confirm double-tap executes exactly once.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StubIntentInterpreter } from '../src/ai/intentInterpreter';
import { parseAuthorizedChatIds, parseAuthorizedIds } from '../src/auth/allowlist';
import { buildApp } from '../src/app';
import type { FastifyInstance } from 'fastify';
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
const FULL_COMBO =
  'vende un perfil de netflix para 4145460657 por 2 meses, pagó 8 USD por zelle, lo recibió Edward';

const SECRET = 'sale-lifecycle-hotfix-test-secret';

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

/** Stub client with reply-markup removal + one-shot edit-failure injection. */
class LifecycleClient implements TelegramClient {
  readonly sent: Array<{ kind: 'send' | 'edit' | 'editMarkup' | 'answer'; payload: unknown }> =
    [];
  private nextId = 700;
  failNextEditWith: string | null = null;

  async sendMessage(opts: CardPayload): Promise<unknown> {
    const messageId = this.nextId;
    this.nextId += 1;
    this.sent.push({ kind: 'send', payload: { ...opts, messageId } });
    return { ok: true, result: { message_id: messageId } };
  }

  async editMessageText(opts: CardPayload & { messageId: number }): Promise<unknown> {
    if (this.failNextEditWith !== null) {
      const message = this.failNextEditWith;
      this.failNextEditWith = null;
      throw new Error(message);
    }
    this.sent.push({ kind: 'edit', payload: opts });
    return { ok: true };
  }

  async editMessageReplyMarkup(opts: { chatId: number; messageId: number }): Promise<unknown> {
    this.sent.push({ kind: 'editMarkup', payload: opts });
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

  sends(): Array<CardPayload & { messageId: number }> {
    return this.sent
      .filter((entry) => entry.kind === 'send')
      .map((entry) => entry.payload as CardPayload & { messageId: number });
  }

  edits(): Array<CardPayload & { messageId: number }> {
    return this.sent
      .filter((entry) => entry.kind === 'edit')
      .map((entry) => entry.payload as CardPayload & { messageId: number });
  }

  markupEdits(): Array<{ chatId: number; messageId: number }> {
    return this.sent
      .filter((entry) => entry.kind === 'editMarkup')
      .map((entry) => entry.payload as { chatId: number; messageId: number });
  }

  answers(): Array<{ callbackQueryId: string; text?: string }> {
    return this.sent
      .filter((entry) => entry.kind === 'answer')
      .map((entry) => entry.payload as { callbackQueryId: string; text?: string });
  }

  texts(): string[] {
    return this.sent
      .filter((entry) => entry.kind === 'send' || entry.kind === 'edit')
      .map((entry) => (entry.payload as CardPayload).text);
  }

  lastText(): string {
    return this.texts().at(-1) ?? '';
  }

  findButton(label: string): string | undefined {
    for (const entry of [...this.sent].reverse()) {
      if (entry.kind !== 'send' && entry.kind !== 'edit') {
        continue;
      }
      const found = (entry.payload as CardPayload).replyMarkup?.inline_keyboard
        .flat()
        .find((button) => button.text === label);
      if (found?.callback_data !== undefined) {
        return found.callback_data;
      }
    }
    return undefined;
  }
}

interface LifecycleWorld {
  app: FastifyInstance;
  client: LifecycleClient;
  interactions: InteractionStore;
  saleDrafts: NewSaleDraftStore;
  mockStore: MockStore;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<void>;
}

async function createLifecycleWorld(): Promise<LifecycleWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-lifecycle-'));
  const mockStore = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const reposStore = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'repos-state.json'),
  });
  const client = new LifecycleClient();
  const interactions = new InteractionStore();
  const saleDrafts = new NewSaleDraftStore();
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions: new SessionStore(),
    drafts: new DraftEngine(),
    interactions,
    interpreter: new StubIntentInterpreter(),
    repos: new MockAccountRepositories(reposStore),
    client,
    sale: { saleDrafts, mockStore },
    alertsTopicId: 25,
  });
  let counter = 6100;
  return {
    app,
    client,
    interactions,
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

function tap(updateId: number, actorId: number, data: string, messageId = 7): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Stranger' },
      message: { message_id: messageId, chat: { id: GROUP_CHAT_ID, type: 'supergroup' } },
      data,
    },
  };
}

function ownerOf(actorId: number): { chatId: number; userId: number } {
  return { chatId: GROUP_CHAT_ID, userId: actorId };
}

/** Confirms Gabriel's FULL_COMBO via the live Confirm button; returns its callback_data. */
async function confirmGabrielSale(world: LifecycleWorld): Promise<string> {
  await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
  const confirmData = world.client.findButton('✅Confirmar');
  expect(confirmData).toBeDefined();
  await world.post(tap(world.nextUpdateId(), GABRIEL, confirmData as string));
  expect(world.mockStore.saleOperations).toHaveLength(1);
  return confirmData as string;
}

describe('HOTFIX 2 lifecycle (16–27)', () => {
  it('(16) new foreground card deactivates the prior Home keyboard (one ACTIVE card)', async () => {
    const world = await createLifecycleWorld();
    await confirmGabrielSale(world);
    const homeSend = world.client.sends().at(-1);
    expect(homeSend?.text).toContain('Vokath');
    // A new operation activates a new foreground card: the prior Home
    // keyboard must be removed so old buttons are not tappable.
    await world.post(
      textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix por 30 dias'),
    );
    const deactivated = world.client
      .markupEdits()
      .some((edit) => edit.messageId === homeSend?.messageId);
    expect(deactivated).toBe(true);
    await world.app.close();
  });

  it('(17) cancel freezes the card compact + fresh Home below (different messageId)', async () => {
    const world = await createLifecycleWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const cardId = world.client.sends()[0]?.messageId;
    const cancelData = world.client.findButton('❌Cancelar');
    expect(cancelData).toBeDefined();
    // Tap on the real card so the freeze lands in place.
    await world.post(tap(world.nextUpdateId(), GABRIEL, cancelData as string, cardId));
    expect(world.saleDrafts.get(ownerOf(GABRIEL))).toBeUndefined();
    // Frozen card: compact result, zero callbacks.
    const frozen = world.client.edits().at(-1);
    expect(frozen?.messageId).toBe(cardId);
    expect(frozen?.text).toContain('❌ Venta cancelada. No se guardó nada.');
    expect(frozen?.replyMarkup?.inline_keyboard.flat() ?? []).toHaveLength(0);
    // Fresh Home below with its own messageId.
    const home = world.client.sends().at(-1);
    expect(home?.messageId).not.toBe(cardId);
    expect(home?.text).toContain('Vokath');
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });

  it('(18) confirm freezes the card (result + WhatsApp) + fresh Home below', async () => {
    const world = await createLifecycleWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const cardId = world.client.sends()[0]?.messageId;
    const confirmData = world.client.findButton('✅Confirmar');
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirmData as string, cardId));
    // Frozen card: final result + WhatsApp preserved, ONLY the external
    // URL button (zero callbacks).
    const frozen = world.client.edits().at(-1);
    expect(frozen?.messageId).toBe(cardId);
    expect(frozen?.text).toContain('✅ VENTA CONFIRMADA');
    expect(frozen?.text).toContain('💬 WhatsApp preparado.');
    const buttons = frozen?.replyMarkup?.inline_keyboard.flat() ?? [];
    expect(buttons.some((button) => button.text === '💬 Abrir WhatsApp')).toBe(true);
    expect(buttons.every((button) => button.callback_data === undefined)).toBe(true);
    // Fresh Home below with a different messageId.
    const home = world.client.sends().at(-1);
    expect(home?.messageId).not.toBe(cardId);
    expect(home?.text).toContain('Vokath');
    await world.app.close();
  });

  it('(19) a new operation never edits the terminal card', async () => {
    const world = await createLifecycleWorld();
    const confirmData = await confirmGabrielSale(world);
    void confirmData;
    const editsOnTerminal = world.client.edits().length;
    await world.post(
      textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix por 30 dias'),
    );
    // The new operation arrives as a NEW send; the terminal card keeps
    // exactly the edits it had (frozen).
    expect(world.client.sends()).toHaveLength(3);
    expect(world.client.edits()).toHaveLength(editsOnTerminal);
    expect(world.client.lastText()).toContain('Teléfono');
    await world.app.close();
  });

  it('(20) repeat Confirm on a frozen card is a safe no-op (ledger stays 1)', async () => {
    const world = await createLifecycleWorld();
    const confirmData = await confirmGabrielSale(world);
    const counts = { sends: world.client.sends().length, edits: world.client.edits().length };
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirmData));
    expect(world.mockStore.saleOperations).toHaveLength(1);
    expect(world.client.sends()).toHaveLength(counts.sends);
    expect(world.client.edits()).toHaveLength(counts.edits);
    expect(
      world.client.answers().some((answer) => answer.text?.includes('ya terminó') === true),
    ).toBe(true);
    await world.app.close();
  });

  it('(21) repeat Cancel on a frozen card is a safe no-op', async () => {
    const world = await createLifecycleWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const cancelData = world.client.findButton('❌Cancelar');
    expect(cancelData).toBeDefined();
    await world.post(tap(world.nextUpdateId(), GABRIEL, cancelData as string));
    expect(world.saleDrafts.get(ownerOf(GABRIEL))).toBeUndefined();
    const counts = { sends: world.client.sends().length, edits: world.client.edits().length };
    await world.post(tap(world.nextUpdateId(), GABRIEL, cancelData as string));
    expect(world.saleDrafts.get(ownerOf(GABRIEL))).toBeUndefined();
    expect(world.client.sends()).toHaveLength(counts.sends);
    expect(world.client.edits()).toHaveLength(counts.edits);
    expect(
      world.client.answers().some((answer) => answer.text?.includes('ya terminó') === true),
    ).toBe(true);
    await world.app.close();
  });

  it('(22) Back on a frozen card never resurrects (stale note, zero edits)', async () => {
    const world = await createLifecycleWorld();
    const confirmData = await confirmGabrielSale(world);
    void confirmData;
    // Forge a Volver tap bound to the frozen terminal interaction.
    const terminal = world.interactions
      .snapshot()
      .find(
        (interaction) =>
          interaction.ownerTelegramUserId === GABRIEL &&
          interaction.type === 'OPERATION' &&
          interaction.status !== 'PENDING',
      );
    expect(terminal).toBeDefined();
    const counts = { sends: world.client.sends().length, edits: world.client.edits().length };
    await world.post(tap(world.nextUpdateId(), GABRIEL, `v1:back:${terminal?.id ?? 'x'}`));
    expect(world.client.sends()).toHaveLength(counts.sends);
    expect(world.client.edits()).toHaveLength(counts.edits);
    expect(
      world.client.answers().some((answer) => answer.text?.includes('ya terminó') === true),
    ).toBe(true);
    // The confirmed ledger row is untouched; no draft resurrected.
    expect(world.mockStore.saleOperations).toHaveLength(1);
    expect(world.saleDrafts.get(ownerOf(GABRIEL))).toBeUndefined();
    await world.app.close();
  });

  it('(23) the next operation starts clean (new operationId, no inheritance)', async () => {
    const world = await createLifecycleWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, `${FULL_COMBO} de Caracas`));
    const firstOp = world.saleDrafts.get(ownerOf(GABRIEL))?.operationId;
    expect(firstOp).toBeDefined();
    const confirmData = world.client.findButton('✅Confirmar');
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirmData as string));
    await world.post(
      textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix por 30 dias'),
    );
    const fresh = world.saleDrafts.get(ownerOf(GABRIEL));
    expect(fresh?.operationId).not.toBe(firstOp);
    expect(fresh?.phone).toBeNull();
    expect(fresh?.customer.existingCustomerId).toBeUndefined();
    expect(fresh?.customer.proposedCustomer).toBeUndefined();
    expect(fresh?.customer.locationUpdate).toBeUndefined();
    expect(fresh?.customer.pendingLocation).toBeUndefined();
    await world.app.close();
  });

  it('(24) actor isolation: Edward works his own card; taps on Gabriel state are rejected', async () => {
    const world = await createLifecycleWorld();
    const confirmData = await confirmGabrielSale(world);
    // Edward runs his own sale end-to-end while Gabriel is terminal.
    await world.post(textMessage(world.nextUpdateId(), EDWARD, FULL_COMBO));
    expect(world.client.lastText()).toContain('VENTA NUEVA');
    expect(world.saleDrafts.get(ownerOf(EDWARD))).not.toBeUndefined();
    // Edward tapping Gabriel's frozen confirm: cross-actor rejection
    // (ownership is checked before terminal state), ledger untouched.
    await world.post(tap(world.nextUpdateId(), EDWARD, confirmData));
    expect(
      world.client.answers().some((answer) => answer.text === 'Esta acción pertenece a Gabriel.'),
    ).toBe(true);
    expect(world.mockStore.saleOperations).toHaveLength(1);
    await world.app.close();
  });

  it('(25) card-lost recovery: a deleted card re-renders into a NEW card, draft intact', async () => {
    const world = await createLifecycleWorld();
    await world.post(
      textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix por 30 dias'),
    );
    const firstId = world.client.sends()[0]?.messageId;
    expect(firstId).toBeDefined();
    // The stored card is deleted before the next turn lands.
    world.client.failNextEditWith = 'Bad Request: message to edit not found';
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, '04149990001'));
    // Recovery: current state rendered into a NEW replacement card with
    // a new id (the draft is the source of truth — nothing is lost).
    expect(world.client.sends()).toHaveLength(2);
    const replacementId = world.client.sends()[1]?.messageId;
    expect(replacementId).not.toBe(firstId);
    expect(world.saleDrafts.get(ownerOf(GABRIEL))?.phone).toBe('04149990001');
    expect(world.client.lastText()).toContain('Nombre del cliente');
    // The flow continues on the adopted card (edits target the new id).
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'Gabriel Juan'));
    const edits = world.client.edits();
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((edit) => edit.messageId === replacementId)).toBe(true);
    await world.app.close();
  });

  it('(26) stale-operation taps refresh the current card and mutate nothing', async () => {
    const world = await createLifecycleWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const confirmData = world.client.findButton('✅Confirmar');
    expect(confirmData).toBeDefined();
    const liveOp = world.saleDrafts.get(ownerOf(GABRIEL))?.operationId;
    expect(liveOp).toBeDefined();
    // Age the interaction's operation binding: the tap now names an
    // operation that is no longer current.
    const parts = (confirmData as string).split(':');
    const interactionId = parts[2] ?? '';
    world.interactions.touch(interactionId, { operationId: 'ns-stale0000' });
    const before = world.saleDrafts.get(ownerOf(GABRIEL));
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirmData as string));
    // No confirm executed (ledger 0): the tap only refreshed the
    // current card — same operation, same business fields.
    expect(world.mockStore.saleOperations).toHaveLength(0);
    const after = world.saleDrafts.get(ownerOf(GABRIEL));
    expect(after?.operationId).toBe(liveOp);
    expect(after?.phone).toBe(before?.phone);
    expect(after?.service).toBe(before?.service);
    expect(after?.payment.method).toBe(before?.payment.method);
    expect(after?.payment.actualAmount).toBe(before?.payment.actualAmount);
    expect(world.client.lastText()).toContain('VENTA NUEVA');
    await world.app.close();
  });

  it('(27) confirm double-tap executes exactly once (ledger 1)', async () => {
    const world = await createLifecycleWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const confirmData = world.client.findButton('✅Confirmar');
    expect(confirmData).toBeDefined();
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirmData as string));
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirmData as string));
    expect(world.mockStore.saleOperations).toHaveLength(1);
    expect(world.client.texts()).toContainEqual(
      expect.stringContaining('✅ VENTA CONFIRMADA'),
    );
    await world.app.close();
  });
});

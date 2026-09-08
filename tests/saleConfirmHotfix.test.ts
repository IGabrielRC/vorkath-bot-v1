/**
 * Phase 4 hotfix — confirmation + active-sale input feedback.
 *
 * Locks the eight required outcomes at the webhook (single-card) level
 * unless a scenario can only be forced in the domain seam:
 *   1. confirm success → CONFIRMED → result + WhatsApp button → fresh Home.
 *   2. no-inventory confirm → draft stays PENDING, zero partial writes,
 *      SIN INVENTARIO card, NO Home.
 *   3. inventory changed → new proposal (recalc summary) + reconfirm,
 *      no Home in between, exactly one committed sale.
 *   4. technical error → PENDING draft + retry affordance, zero writes,
 *      NO Home (domain seam via failAt; keyboard asserted too).
 *   5. unknown commit → reconcile by operationId: render failure after
 *      commit shows committed data + WhatsApp + Home, never a resell.
 *   6. active sale + unrelated SEARCH → pending-management feedback on
 *      the SAME card, draft intact, no second card.
 *   7. active sale + "hola" → never cancels, never silent.
 *   8. fresh Home only for CONFIRMED/CANCELLED (never for
 *      no-inventory / technical error / pending-management).
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
import type { Customer } from '../src/mock/customers';
import { NewSaleDraftStore } from '../src/sale/newSaleDraft';
import {
  prepareNewSaleFromAction,
  prepareNewSaleFromText,
  type SaleActor,
  type SaleDeps,
} from '../src/sale/newSaleTool';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';
import { HOME_TEXT } from '../src/telegram/keyboards';

const GABRIEL = 1057242322;
const EDWARD = 941030473;
const GROUP_CHAT_ID = -1005550001;
const SECRET = 'sale-confirm-hotfix-test-secret';

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

/** Stub client: incrementing message ids, fail-on-next-edit injection, send/edit inspection. */
class HotfixClient implements TelegramClient {
  readonly sent: Array<{ kind: 'send' | 'edit' | 'markup' | 'answer'; payload: unknown }> = [];
  private nextId = 500;
  failNextEditWith: unknown = undefined;

  async sendMessage(opts: CardPayload): Promise<unknown> {
    const messageId = this.nextId;
    this.nextId += 1;
    this.sent.push({ kind: 'send', payload: { ...opts, messageId } });
    return { ok: true, result: { message_id: messageId } };
  }

  async editMessageText(opts: CardPayload & { messageId: number }): Promise<unknown> {
    if (this.failNextEditWith !== undefined) {
      const failure = this.failNextEditWith;
      this.failNextEditWith = undefined;
      throw failure;
    }
    this.sent.push({ kind: 'edit', payload: opts });
    return { ok: true };
  }

  async editMessageReplyMarkup(opts: unknown): Promise<unknown> {
    this.sent.push({ kind: 'markup', payload: opts });
    return { ok: true };
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    opts?: { text?: string },
  ): Promise<unknown> {
    this.sent.push({ kind: 'answer', payload: { callbackQueryId, ...(opts?.text !== undefined ? { text: opts.text } : {}) } });
    return { ok: true };
  }

  cards(): Array<CardPayload & { messageId?: number }> {
    return this.sent
      .filter((entry) => entry.kind === 'send' || entry.kind === 'edit')
      .map((entry) => entry.payload as CardPayload & { messageId?: number });
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

  lastButtons(): Array<{ text: string; callback_data?: string; url?: string }> {
    const last = this.cards().at(-1);
    return last?.replyMarkup?.inline_keyboard.flat() ?? [];
  }

  findButton(label: string): string | undefined {
    for (const card of [...this.cards()].reverse()) {
      const found = card.replyMarkup?.inline_keyboard
        .flat()
        .find((button) => button.text === label);
      if (found?.callback_data !== undefined) {
        return found.callback_data;
      }
    }
    return undefined;
  }
}

interface HotfixWorld {
  app: FastifyInstance;
  client: HotfixClient;
  interpreter: StubIntentInterpreter;
  saleDrafts: NewSaleDraftStore;
  mockStore: MockStore;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<void>;
}

async function createHotfixWorld(): Promise<HotfixWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-confirm-hotfix-'));
  const mockStore = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const reposStore = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'repos-state.json'),
  });
  const client = new HotfixClient();
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

const owner = (actorId: number): { chatId: number; userId: number } => ({
  chatId: GROUP_CHAT_ID,
  userId: actorId,
});

function lastText(world: HotfixWorld): string {
  return world.client.cards().at(-1)?.text ?? '';
}

function isHome(text: string): boolean {
  return text.includes('Vokath') && text.includes('hacemos');
}

describe('phase 4 confirm hotfix', () => {
  it('(1) confirm success → CONFIRMED card (result + WhatsApp) + fresh Home below', async () => {
    const world = await createHotfixWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    expect(world.client.sends()).toHaveLength(1);
    const confirm = world.client.findButton('✅Confirmar');
    expect(confirm).toBeDefined();
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirm as string));

    const confirmedEdit = world.client.edits().at(-1);
    const confirmed = confirmedEdit?.text ?? '';
    expect(confirmed).toContain('✅ VENTA CONFIRMADA');
    expect(confirmed).toContain('Contraseña');
    expect(confirmed).toContain('💬 WhatsApp preparado.');
    // The frozen card keeps ONLY the WhatsApp URL button (zero callbacks).
    const whatsapp = confirmedEdit?.replyMarkup?.inline_keyboard
      .flat()
      .find((b) => b.text.includes('Abrir WhatsApp'));
    expect(whatsapp?.url).toMatch(/^https:\/\/wa\.me\/584145460657\?text=/);
    expect(whatsapp?.callback_data).toBeUndefined();

    // Fresh Home is the only second send (frozen card is an edit).
    expect(world.client.sends()).toHaveLength(2);
    expect(isHome(world.client.sends().at(-1)?.text ?? '')).toBe(true);

    // Exactly one committed sale.
    expect(world.mockStore.saleOperations).toHaveLength(1);
    expect(world.saleDrafts.confirmed(owner(GABRIEL))?.status).toBe('CONFIRMED');
    await world.app.close();
  });

  it('(2) no-inventory confirm → draft PENDING, zero writes, SIN INVENTARIO, NO Home', async () => {
    const world = await createHotfixWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    expect(world.client.sends()).toHaveLength(1);
    // Drain the sale inventory after the summary (race: someone took it).
    world.mockStore.accounts.length = 0;
    const confirm = world.client.findButton('✅Confirmar');
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirm as string));

    const card = lastText(world);
    expect(card).toContain('SIN INVENTARIO');
    expect(card).toContain('No hay inventario disponible');
    // Draft stays PENDING (DRAFT) — never marked CONFIRMED.
    expect(world.saleDrafts.get(owner(GABRIEL))?.status).toBe('DRAFT');
    expect(world.saleDrafts.confirmed(owner(GABRIEL))).toBeUndefined();
    // Zero partial writes.
    expect(world.mockStore.saleOperations).toHaveLength(0);
    expect(world.mockStore.saleSubscriptions).toHaveLength(0);
    expect(world.mockStore.salePayments).toHaveLength(0);
    expect(world.mockStore.saleMovements).toHaveLength(0);
    // No Home: still exactly ONE send (the summary), the failure edited it.
    expect(world.client.sends()).toHaveLength(1);
    expect(isHome(lastText(world))).toBe(false);
    await world.app.close();
  });

  it('(3) inventory changed → new proposal (recalc summary) + reconfirm, no Home in between', async () => {
    const world = await createHotfixWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const draft = world.saleDrafts.get(owner(GABRIEL));
    const firstSlot = draft?.proposal?.slotId ?? '';
    const rowIndex = draft?.proposal?.evidence.rowIndex ?? -1;
    // A peer grabs the evidenced slot before the operator confirms.
    world.mockStore.assignSaleSlot(rowIndex, {
      nombre: 'Intruso',
      numero: '7000000',
      fechaInicio: '2026-01-01',
      fechaFin: '2026-02-01',
    });

    const confirm = world.client.findButton('✅Confirmar');
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirm as string));
    const recalc = lastText(world);
    expect(recalc).toContain('inventario cambió');
    expect(world.mockStore.saleOperations).toHaveLength(0);
    // No Home on the recalc (still exactly one send).
    expect(world.client.sends()).toHaveLength(1);

    const draftAfter = world.saleDrafts.get(owner(GABRIEL));
    expect(draftAfter?.proposal?.slotId).not.toBe(firstSlot);
    // Reconfirm the new proposal → committed once, fresh Home below.
    const confirmAgain = world.client.findButton('✅Confirmar');
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirmAgain as string));
    expect(world.client.edits().at(-1)?.text ?? '').toContain('✅ VENTA CONFIRMADA');
    expect(world.mockStore.saleOperations).toHaveLength(1);
    expect(world.mockStore.saleOperations[0]?.slotId).toBe(draftAfter?.proposal?.slotId);
    expect(world.client.sends()).toHaveLength(2);
    expect(isHome(world.client.sends().at(-1)?.text ?? '')).toBe(true);
    await world.app.close();
  });

  it('(4) technical error → PENDING draft + retry, zero writes, NO Home (domain seam)', async () => {
    // Domain seam: failAt forces the atomic commit to throw mid-write and
    // roll back completely. The confirm result must be a retryable error
    // that keeps the draft PENDING and writes nothing.
    const dir = mkdtempSync(join(tmpdir(), 'vokath-confirm-fail-'));
    const store = await MockStore.create({
      fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
      statePath: join(dir, 'mock-state.json'),
    });
    const reposStore = await MockStore.create({
      fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
      statePath: join(dir, 'repos.json'),
    });
    const repos = new MockAccountRepositories(reposStore);
    const saleStore = new NewSaleDraftStore();
    const alerts: Array<{ title: string; summary: string }> = [];
    const deps: SaleDeps = {
      store: saleStore,
      findCustomersByPhone: (raw: string) => repos.searchCustomersByPhone(raw),
      inventoryRows: store.accounts,
      saleExec: { mockStore: store, failAt: 'payment', onAlert: (alert) => alerts.push(alert) },
    };
    const actor: SaleActor = { chatId: GROUP_CHAT_ID, userId: GABRIEL, name: 'Gabriel' };
    const prepared = await prepareNewSaleFromText(actor, FULL_COMBO, deps);
    expect(prepared.kind).toBe('summary');
    const result = await prepareNewSaleFromAction(actor, { type: 'confirm-sale' }, deps);
    expect(result.kind).toBe('clarification');
    expect(result.retryable).toBe(true);
    expect(result.text).toContain('no pudo registrarse');
    expect(result.text).not.toContain('Confirmando');
    expect(saleStore.get(owner(GABRIEL))?.status).toBe('DRAFT');
    expect(store.saleOperations).toHaveLength(0);
    expect(store.saleSubscriptions).toHaveLength(0);
    expect(store.salePayments).toHaveLength(0);
    expect(store.saleMovements).toHaveLength(0);
    expect(alerts).toHaveLength(1);
    // A retry (fresh confirm, no injected fault) re-commits from the intact
    // draft → exactly one sale.
    const retryDeps: SaleDeps = { ...deps, saleExec: { mockStore: store } };
    const retried = await prepareNewSaleFromAction(actor, { type: 'confirm-sale' }, retryDeps);
    expect(retried.kind).toBe('confirmed');
    expect(store.saleOperations).toHaveLength(1);
  });

  it('(4b) WEBHOOK confirm technical failure → same-card human error + retry, draft PENDING, NO Home', async () => {
    // Full webhook orchestration (not the domain seam): a real Confirm
    // tap runs runSaleConfirmFlow → prepareNewSaleFromAction → atomic
    // commit. Fault-inject the shared store's slot assignment so the
    // commit throws mid-write through that real path.
    const world = await createHotfixWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const summary = world.client.sends()[0];
    expect(world.client.sends()).toHaveLength(1);
    world.mockStore.assignSaleSlot = (() => {
      throw new Error('injected confirm failure at assignment');
    }) as typeof world.mockStore.assignSaleSlot;
    const confirm = world.client.findButton('✅Confirmar');
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirm as string));

    // Draft stays PENDING (DRAFT) — never CONFIRMED.
    expect(world.saleDrafts.get(owner(GABRIEL))?.status).toBe('DRAFT');
    expect(world.saleDrafts.confirmed(owner(GABRIEL))).toBeUndefined();
    // Zero partial writes (full rollback).
    expect(world.mockStore.saleOperations).toHaveLength(0);
    expect(world.mockStore.saleSubscriptions).toHaveLength(0);
    expect(world.mockStore.salePayments).toHaveLength(0);
    expect(world.mockStore.saleMovements).toHaveLength(0);
    // The SAME tapped card is edited to a human error (no codes/stacks).
    const errorEdit = world.client.edits().at(-1);
    const errorText = errorEdit?.text ?? '';
    expect(errorText).toContain('no pudo registrarse');
    expect(errorText).toContain('fallo técnico');
    expect(errorText).toContain('No se guardó nada');
    // Retry affordance on the same card: [▶️ Continuar venta][❌Cancelar venta].
    const retryButtons = errorEdit?.replyMarkup?.inline_keyboard.flat() ?? [];
    expect(retryButtons.map((b) => b.text)).toContain('▶️ Continuar venta');
    expect(retryButtons.map((b) => b.text)).toContain('❌Cancelar venta');
    // NO fresh Home is sent after a recoverable failure.
    expect(world.client.sends().some((s) => isHome(s.text ?? ''))).toBe(false);
    await world.app.close();
  });

  it('(5) unknown commit → reconcile by operationId: committed data + WhatsApp + Home, no resell', async () => {
    const world = await createHotfixWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const confirm = world.client.findButton('✅Confirmar');
    // Simulate a render failure AFTER the atomic commit: the confirmed-card
    // edit throws (non-card-lost), so the confirm flow must reconcile and
    // show the committed sale (already-confirmed) instead of an error.
    world.client.failNextEditWith = new Error('simulated render failure');
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirm as string));

    const reconciled = world.client.edits().at(-1)?.text ?? '';
    expect(reconciled).toContain('VENTA CONFIRMADA');
    expect(reconciled).toContain('Contraseña');
    expect(reconciled).toContain('💬 WhatsApp preparado.');
    // Fresh Home still lands (terminal outcome).
    expect(world.client.sends()).toHaveLength(2);
    expect(isHome(world.client.sends().at(-1)?.text ?? '')).toBe(true);
    // Exactly ONE committed sale — the reconcile never resells.
    expect(world.mockStore.saleOperations).toHaveLength(1);
    expect(world.mockStore.salePayments).toHaveLength(1);
    expect(world.mockStore.saleMovements).toHaveLength(1);
    await world.app.close();
  });

  it('(6) active sale + unrelated SEARCH → pending-management on the SAME card, draft intact', async () => {
    const world = await createHotfixWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const draftBefore = world.saleDrafts.get(owner(GABRIEL));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'busca al cliente anny tovar'));

    const card = lastText(world);
    expect(card).toContain('Tienes una gestión pendiente');
    expect(card).toContain('Continúa o cancela');
    // No second card (still exactly one send), no cancel, draft intact.
    expect(world.client.sends()).toHaveLength(1);
    const draftAfter = world.saleDrafts.get(owner(GABRIEL));
    expect(draftAfter?.operationId).toBe(draftBefore?.operationId);
    expect(draftAfter?.status).toBe('DRAFT');
    // Global search/Gemini never saw the message.
    expect(world.interpreter.calls).toBe(0);
    // The pending card offers resume/cancel on the same card.
    expect(world.client.findButton('▶️ Continuar venta')).toBeDefined();
    expect(world.client.findButton('❌Cancelar venta')).toBeDefined();
    await world.app.close();
  });

  it('(6b) active sale + READ intent ("datos") → exact pending-management on the same card, no cancel, no Home', async () => {
    const world = await createHotfixWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const draftBefore = world.saleDrafts.get(owner(GABRIEL));
    const summary = world.client.sends()[0];
    // "datos" is a read/credential intent — never a sale field, never a
    // command, so the active-sale guard answers the exact pending notice.
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'datos'));

    // Exact pending-management sentence (only the operator label trails).
    const card = lastText(world);
    expect(card.split('\n')[0]).toBe('Tienes una gestión pendiente. Continúa o cancela.');
    // Same card edited in place — no new card, no cancellation, no Home.
    expect(world.client.sends()).toHaveLength(1);
    expect(world.client.edits().at(-1)?.messageId).toBe(summary.messageId);
    const draftAfter = world.saleDrafts.get(owner(GABRIEL));
    expect(draftAfter?.operationId).toBe(draftBefore?.operationId);
    expect(draftAfter?.status).toBe('DRAFT');
    expect(world.saleDrafts.confirmed(owner(GABRIEL))).toBeUndefined();
    expect(isHome(card)).toBe(false);
    expect(world.client.sends().some((s) => isHome(s.text ?? ''))).toBe(false);
    await world.app.close();
  });

  it('(7) active sale + "hola" → never cancels, never silent, exact pending notice, no Home', async () => {
    const world = await createHotfixWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const draftBefore = world.saleDrafts.get(owner(GABRIEL));
    const summary = world.client.sends()[0];
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'hola'));

    // Feedback was produced (not silent) on the SAME card with the exact
    // pending-management sentence (operator label only trails it).
    const card = lastText(world);
    expect(card.split('\n')[0]).toBe('Tienes una gestión pendiente. Continúa o cancela.');
    // No second card: the pending notice EDITED the summary card in place.
    expect(world.client.sends()).toHaveLength(1);
    expect(world.client.edits().at(-1)?.messageId).toBe(summary.messageId);
    // Not cancelled, not confirmed, no fresh Home.
    const draftAfter = world.saleDrafts.get(owner(GABRIEL));
    expect(draftAfter).toBeDefined();
    expect(draftAfter?.operationId).toBe(draftBefore?.operationId);
    expect(draftAfter?.status).toBe('DRAFT');
    expect(world.saleDrafts.confirmed(owner(GABRIEL))).toBeUndefined();
    expect(isHome(card)).toBe(false);
    expect(world.client.sends().some((s) => isHome(s.text ?? ''))).toBe(false);
    await world.app.close();
  });

  it('(8) fresh Home only for CONFIRMED/CANCELLED — not for pending-management', async () => {
    // Pending-management (unrelated search during an active sale) must NOT
    // emit a fresh Home: exactly one send, same card.
    const world = await createHotfixWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'busca al cliente anny tovar'));
    expect(world.client.sends()).toHaveLength(1);
    expect(isHome(lastText(world))).toBe(false);

    // Explicit Cancel is terminal → CANCELLED frozen card + fresh Home.
    const cancel = world.client.findButton('❌Cancelar venta');
    await world.post(tap(world.nextUpdateId(), GABRIEL, cancel as string));
    expect(world.client.edits().at(-1)?.text ?? '').toContain('Venta cancelada');
    expect(world.client.sends()).toHaveLength(2);
    expect(isHome(world.client.sends().at(-1)?.text ?? '')).toBe(true);
    await world.app.close();
  });

  it('(8b) fresh Home only for CONFIRMED/CANCELLED — confirm is terminal + Home, Home text present', async () => {
    const world = await createHotfixWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const confirm = world.client.findButton('✅Confirmar');
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirm as string));
    expect(world.client.sends()).toHaveLength(2);
    const home = world.client.sends().at(-1)?.text ?? '';
    expect(isHome(home)).toBe(true);
    expect(home).toContain(HOME_TEXT);
    await world.app.close();
  });

  it('(8c) textual explicit "cancelar" during an active sale → CANCELLED same card + fresh Home', async () => {
    // Button-based cancel is covered; this proves the explicit NL command
    // cancels the SAME way through the active-sale text handler.
    const world = await createHotfixWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const summary = world.client.sends()[0];
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'cancelar'));
    // Draft dropped, SAME card frozen compact, fresh Home below.
    expect(world.saleDrafts.get(owner(GABRIEL))).toBeUndefined();
    expect(world.saleDrafts.confirmed(owner(GABRIEL))).toBeUndefined();
    expect(world.client.edits().at(-1)?.messageId).toBe(summary.messageId);
    expect(world.client.edits().at(-1)?.text ?? '').toContain('Venta cancelada');
    expect(world.client.sends()).toHaveLength(2);
    expect(isHome(world.client.sends().at(-1)?.text ?? '')).toBe(true);
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });
});
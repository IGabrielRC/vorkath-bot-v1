/**
 * Production-smoke fixes (commit 7b3453f follow-up):
 * - New-customer resolution converges into recompute → expectedSaleFields
 *   → batch render (unknown phone + 4 missing → 4 shown; full answer →
 *   direct summary; same operationId + same bot messageId, no 2nd card).
 * - Fresh-sale-no-phone isolation: prior search / selection /
 *   finished-interaction context NEVER fills a fresh sale's
 *   phone/customer (explicit current-turn identifier only).
 * - Old substantive draft + explicit new intent ([Venta nueva] button
 *   included) → GESTIÓN PENDIENTE on the SAME card, old draft intact,
 *   no hybrid.
 * - Volver traceability for text-started sales: the OPERATION
 *   interaction carries a real NavStack (sale-entry parent + sale views,
 *   same semantics as callback-start); Volver pops to the exact
 *   producing view, never swaps phones, never drops/cancels the draft.
 *
 * Worlds wire the additive `sale` deps; the stub client returns
 * incrementing `message_id`s so single-card lineage is observable.
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
  prepareNewSaleFromText,
  type SaleActor,
  type SaleDeps,
} from '../src/sale/newSaleTool';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';

const GABRIEL = 1057242322;
const EDWARD = 941030473;
const GROUP_CHAT_ID = -1005550001;
const GABRIEL_ACTOR: SaleActor = { chatId: GROUP_CHAT_ID, userId: GABRIEL, name: 'Gabriel' };
const KNOWN_PHONE = '4145460657';
const UNKNOWN_PHONE = '04149990001';
const FULL_COMBO =
  'vende un perfil de netflix para 4145460657 por 2 meses, pagó 8 USD por zelle, lo recibió Edward';

const SECRET = 'sale-smoke-fix-test-secret-long';

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

class CardClient implements TelegramClient {
  readonly sent: Array<{ kind: 'send' | 'edit' | 'answer'; payload: unknown }> = [];
  private nextId = 900;

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

  async answerCallbackQuery(callbackQueryId: string, opts?: { text?: string }): Promise<unknown> {
    this.sent.push({
      kind: 'answer',
      payload: { callbackQueryId, ...(opts?.text !== undefined ? { text: opts.text } : {}) },
    });
    return { ok: true };
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

interface SmokeWorld {
  app: FastifyInstance;
  client: CardClient;
  saleDrafts: NewSaleDraftStore;
  interactions: InteractionStore;
  interpreter: StubIntentInterpreter;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<void>;
}

async function createSmokeWorld(): Promise<SmokeWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-smoke-'));
  const mockStore = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const reposStore = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'repos-state.json'),
  });
  const client = new CardClient();
  const saleDrafts = new NewSaleDraftStore();
  const interactions = new InteractionStore();
  const interpreter = new StubIntentInterpreter();
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions: new SessionStore(),
    drafts: new DraftEngine(),
    interactions,
    interpreter,
    repos: new MockAccountRepositories(reposStore),
    client,
    sale: { saleDrafts, mockStore },
    alertsTopicId: 25,
  });
  let counter = 4200;
  return {
    app,
    client,
    saleDrafts,
    interactions,
    interpreter,
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

async function fixtureWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-smoke-tool-'));
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const repos = new MockAccountRepositories(store);
  return { store, repos, rows: store.accounts };
}

function toolDeps(
  saleStore: NewSaleDraftStore,
  rows: MockAccount[],
  lookup: (phone: string) => Customer[] | Promise<Customer[]>,
): SaleDeps {
  return { store: saleStore, findCustomersByPhone: lookup, inventoryRows: rows };
}

// ---------------------------------------------------------------------------
// S1–S3: smoke batch convergence (tool level)
// ---------------------------------------------------------------------------

describe('smoke tool: new-customer converges into the batch path', () => {
  it('(S0) confirmed draft never resumes: the next cue opens a clean operation', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw));
    const first = await prepareNewSaleFromText(GABRIEL_ACTOR, FULL_COMBO, deps);
    expect(first.kind).toBe('summary');
    const owner = { chatId: GROUP_CHAT_ID, userId: GABRIEL };
    saleStore.confirmSale(owner);
    const second = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'dame una cuenta nueva netflix por 30 dias',
      deps,
    );
    // New operationId, phone MISSING — the confirmed header is kept for
    // repeat-confirm lookup only and never fills the fresh draft.
    expect(second.draft?.operationId).not.toBe(first.draft?.operationId);
    expect(second.draft?.phone).toBeNull();
    expect(second.missingFields).toEqual(['customer', 'method', 'amount', 'receiver']);
  });

  it('(S1) no-phone cue → 4-field batch, phone starts MISSING', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'dame una cuenta nueva netflix por 30 dias',
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('ask-missing');
    expect(result.missingFields).toEqual(['customer', 'method', 'amount', 'receiver']);
    expect(result.draft?.phone).toBeNull();
    expect(result.text).toContain('UN mensaje');
    expect(result.text).toContain('teléfono');
  });

  it('(S2) unknown phone + 3 more missing → ONE name batch (4 shown), same op', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw));
    const first = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'dame una cuenta nueva netflix por 30 dias',
      deps,
    );
    const second = await prepareNewSaleFromText(GABRIEL_ACTOR, UNKNOWN_PHONE, deps);
    expect(second.kind).toBe('new-customer');
    expect(second.missingFields).toEqual(['customer', 'method', 'amount', 'receiver']);
    // Batch, not the legacy single-name card: every missing field named…
    expect(second.text).toContain('UN mensaje');
    expect(second.text).toContain('Método');
    expect(second.text).toContain('Monto');
    expect(second.text).toContain('Gabriel o Edward');
    // …with the customer bullet asking the NAME for this number (never
    // the phone again).
    expect(second.text).toContain(`Nombre del cliente para ${UNKNOWN_PHONE}`);
    expect(second.draft?.operationId).toBe(first.draft?.operationId);
    expect(second.draft?.phone).toBe(UNKNOWN_PHONE);
  });

  it('(S3) full batch answer → direct summary, same op', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw));
    const first = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'dame una cuenta nueva netflix por 30 dias',
      deps,
    );
    await prepareNewSaleFromText(GABRIEL_ACTOR, UNKNOWN_PHONE, deps);
    const done = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'Juan Pérez, Zelle, 4 dólares, lo recibió Edward',
      deps,
    );
    expect(done.kind).toBe('summary');
    expect(done.draft?.operationId).toBe(first.draft?.operationId);
    expect(done.draft?.customer.proposedCustomer).toMatchObject({
      name: 'Juan Pérez',
      phone: UNKNOWN_PHONE,
    });
    expect(done.draft?.payment.method).toBe('zelle');
    expect(done.draft?.payment.actualAmount).toBe(4);
    expect(done.draft?.payment.receivedBy).toBe('Edward');
  });
});

// ---------------------------------------------------------------------------
// S4–S6: webhook lineage (same op + same message, zero Gemini)
// ---------------------------------------------------------------------------

describe('smoke webhook: batch lineage on ONE card', () => {
  it('(S4) cue → unknown phone → full answer: 1 send, same message id, same op', async () => {
    const world = await createSmokeWorld();
    await world.post(
      textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix por 30 dias'),
    );
    const opFirst = world.saleDrafts.get(ownerOf(GABRIEL))?.operationId;
    expect(opFirst).toBeDefined();
    expect(world.client.sends()).toHaveLength(1);
    expect(world.client.lastText()).toContain('UN mensaje');

    await world.post(textMessage(world.nextUpdateId(), GABRIEL, UNKNOWN_PHONE));
    expect(world.client.sends()).toHaveLength(1);
    expect(world.client.edits()).toHaveLength(1);
    expect(world.client.lastText()).toContain(`Nombre del cliente para ${UNKNOWN_PHONE}`);
    expect(world.client.lastText()).toContain('UN mensaje');
    expect(world.saleDrafts.get(ownerOf(GABRIEL))?.operationId).toBe(opFirst);

    await world.post(
      textMessage(
        world.nextUpdateId(),
        GABRIEL,
        'Juan Pérez, Zelle, 4 dólares, lo recibió Edward',
      ),
    );
    expect(world.client.sends()).toHaveLength(1);
    expect(world.client.lastText()).toContain('VENTA NUEVA');
    expect(world.client.lastText()).toContain('Juan Pérez (nuevo)');
    const ids = new Set([
      world.client.sends()[0]?.messageId,
      ...world.client.edits().map((edit) => edit.messageId),
    ]);
    expect(ids.size).toBe(1);
    expect(world.saleDrafts.get(ownerOf(GABRIEL))?.operationId).toBe(opFirst);
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });
});

// ---------------------------------------------------------------------------
// S5–S6: previous-context isolation
// ---------------------------------------------------------------------------

describe('smoke webhook: previous context never fills a fresh sale', () => {
  it('(S5) last searched phone + prior selection stay out of the fresh draft', async () => {
    const world = await createSmokeWorld();
    // Prior SEARCH context: unknown-phone lookup, then a known-phone
    // card (stores query + selectedCustomer on SEARCH interactions).
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, UNKNOWN_PHONE));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, KNOWN_PHONE));
    expect(world.client.lastText()).toContain('Anny Tovar');

    // Fresh explicit sale: phone starts MISSING and is asked — the
    // searched/selected 4145460657 never leaks into the new operation.
    await world.post(
      textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix por 30 dias'),
    );
    const draft = world.saleDrafts.get(ownerOf(GABRIEL));
    expect(draft?.phone).toBeNull();
    expect(draft?.customer.existingCustomerId).toBeUndefined();
    expect(draft?.customer.proposedCustomer).toBeUndefined();
    expect(world.client.lastText()).toContain('teléfono');
    expect(world.client.lastText()).not.toContain('Anny Tovar');
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(S6) finished (confirmed) context + peer drafts never leak across operations', async () => {
    const world = await createSmokeWorld();
    // Edward completes a full operation (CONFIRMED draft + interaction).
    await world.post(textMessage(world.nextUpdateId(), EDWARD, FULL_COMBO));
    const confirmData = world.client.findButton('✅Confirmar');
    expect(confirmData).toBeDefined();
    await world.post(tap(world.nextUpdateId(), EDWARD, confirmData as string));
    expect(world.client.lastText()).toContain('VENTA CONFIRMADA');

    // Gabriel's fresh sale starts clean despite Edward's confirmed sale
    // and his own (nonexistent) history.
    await world.post(
      textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix por 30 dias'),
    );
    const gabriel = world.saleDrafts.get(ownerOf(GABRIEL));
    expect(gabriel?.phone).toBeNull();
    expect(world.client.lastText()).toContain('teléfono');

    // Same actor after his OWN finished sale: close it explicitly
    // (cancel drops the draft whatever state the ledger left), then a
    // fresh cue must still start with the phone MISSING.
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'cancelar'));
    expect(world.saleDrafts.get(ownerOf(GABRIEL))).toBeUndefined();
    await world.post(
      textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix por 30 dias'),
    );
    const second = world.saleDrafts.get(ownerOf(GABRIEL));
    expect(second?.phone).toBeNull();
    expect(world.client.lastText()).toContain('teléfono');
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });
});

// ---------------------------------------------------------------------------
// S7: old draft + explicit new intent → pending, no hybrid
// ---------------------------------------------------------------------------

describe('smoke webhook: prior draft + new intent is managed, never merged', () => {
  it('(S7) [Venta nueva] over a substantive draft → GESTIÓN PENDIENTE, draft intact', async () => {
    const world = await createSmokeWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const before = world.saleDrafts.get(ownerOf(GABRIEL));
    expect(before?.service).toBe('netflix');

    // Explicit new intent via the OPERAR entry + [Venta nueva] button.
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const operar = world.client.findButton('⚡OPERAR');
    expect(operar).toBeDefined();
    await world.post(tap(world.nextUpdateId(), GABRIEL, operar as string));
    const saleNew = world.client.findButton('🛒 Venta nueva');
    expect(saleNew).toBeDefined();
    await world.post(tap(world.nextUpdateId(), GABRIEL, saleNew as string));

    expect(world.client.lastText()).toContain('GESTIÓN PENDIENTE');
    // Same card: no parallel operational card was opened (only the
    // summary send and the /start Home send exist; entry + pending
    // are in-place edits).
    expect(world.client.sends()).toHaveLength(2);
    // Old draft byte-intact: same op, same service/phone/payment.
    const after = world.saleDrafts.get(ownerOf(GABRIEL));
    expect(after?.operationId).toBe(before?.operationId);
    expect(after?.service).toBe('netflix');
    expect(after?.phone).toBe(KNOWN_PHONE);
    expect(after?.payment.method).toBe('zelle');
    // Pending keyboard offers resume/cancel on the same card.
    expect(world.client.findButton('▶️ Continuar venta')).toBeDefined();
    expect(world.client.findButton('❌Cancelar venta')).toBeDefined();

    // [Continuar venta] resumes the intact draft on the same card.
    const keep = world.client.findButton('▶️ Continuar venta');
    await world.post(tap(world.nextUpdateId(), GABRIEL, keep as string));
    expect(world.client.lastText()).toContain('VENTA NUEVA');
    expect(world.saleDrafts.get(ownerOf(GABRIEL))?.operationId).toBe(before?.operationId);
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });
});

// ---------------------------------------------------------------------------
// S8–S10: Volver traceability (text-start shares callback-start semantics)
// ---------------------------------------------------------------------------

describe('smoke webhook: Volver pops the sale stack, never mutates the draft', () => {
  it('(S8) Volver from the name batch → entry card, same message, phone kept', async () => {
    const world = await createSmokeWorld();
    await world.post(
      textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix por 30 dias'),
    );
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, UNKNOWN_PHONE));
    const opBefore = world.saleDrafts.get(ownerOf(GABRIEL))?.operationId;
    expect(world.client.lastText()).toContain('UN mensaje');

    const volver = world.client.findButton('←Volver');
    expect(volver).toBeDefined();
    await world.post(tap(world.nextUpdateId(), GABRIEL, volver as string));

    // Exact producing view (the OPERAR entry), same card, draft intact.
    expect(world.client.sends()).toHaveLength(1);
    expect(world.client.lastText()).toContain('¿Qué operamos?');
    const draft = world.saleDrafts.get(ownerOf(GABRIEL));
    expect(draft?.operationId).toBe(opBefore);
    expect(draft?.phone).toBe(UNKNOWN_PHONE);
    expect(draft?.service).toBe('netflix');
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(S9) second Volver → Home root, draft STILL intact (nav never mutates business)', async () => {
    const world = await createSmokeWorld();
    await world.post(
      textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix por 30 dias'),
    );
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, UNKNOWN_PHONE));
    const opBefore = world.saleDrafts.get(ownerOf(GABRIEL))?.operationId;

    const volver = world.client.findButton('←Volver');
    await world.post(tap(world.nextUpdateId(), GABRIEL, volver as string));
    const volver2 = world.client.findButton('←Volver');
    expect(volver2).toBeDefined();
    await world.post(tap(world.nextUpdateId(), GABRIEL, volver2 as string));

    expect(world.client.lastText()).toContain('🏠 Vokath');
    const draft = world.saleDrafts.get(ownerOf(GABRIEL));
    expect(draft?.operationId).toBe(opBefore);
    expect(draft?.phone).toBe(UNKNOWN_PHONE);
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(S10) callback-start shares the text-start NavStack semantics', async () => {
    const world = await createSmokeWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const operar = world.client.findButton('⚡OPERAR');
    expect(operar).toBeDefined();
    await world.post(tap(world.nextUpdateId(), GABRIEL, operar as string));
    const saleNew = world.client.findButton('🛒 Venta nueva');
    await world.post(tap(world.nextUpdateId(), GABRIEL, saleNew as string));
    expect(world.client.lastText()).toContain('¿Qué servicio vendemos');

    // Volver from the first callback-started sale card → the entry card
    // that produced it (same as the text-started flow), same message.
    const volver = world.client.findButton('←Volver');
    expect(volver).toBeDefined();
    await world.post(tap(world.nextUpdateId(), GABRIEL, volver as string));
    expect(world.client.lastText()).toContain('¿Qué operamos?');
    expect(world.client.sends()).toHaveLength(1);
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });
});

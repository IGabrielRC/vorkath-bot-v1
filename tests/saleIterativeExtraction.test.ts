/**
 * Iterative / fixed-point extraction + callback ack ordering.
 *
 * Real failing input (ONE message):
 *   "dame una cuenta nueva netflix por 30 dias Juan Diaz 4$ 04248723454"
 * service/modality/duration/phone resolved, but the name-before-needed
 * ("Juan Diaz") and the trailing-sign amount ("4$") were lost:
 * - "Juan Diaz": `extractNameRemainder` ran ONLY on resumed drafts with
 *   a prior-turn phone (`base.phone !== null`, no phone in text) — a
 *   fresh turn never re-evaluated its own leftovers once the phone
 *   lookup made customerName required. Fixed-point loop fixes the root.
 * - "4$": `AMOUNT_EXPLICIT_RE` ended in `\b`, which can never follow the
 *   non-word `$` (`4$`+space/end = non-word boundary, no match). The
 *   currency lookahead `(?![A-Za-z0-9_])` fixes the root (and the same
 *   `\b` in the remainder strip, which let `4$` poison the name).
 *
 * Worlds wire the additive `sale` deps; the stub client records
 * received/ack/edit stages so ack ordering is attributable.
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
  type ScopedRemainderArgs,
  type ScopedRemainderInterpreter,
} from '../src/sale/newSaleTool';
import { parseSaleExtraction } from '../src/sale/saleParser';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';

const GABRIEL = 1057242322;
const EDWARD = 941030473;
const GROUP_CHAT_ID = -1005550001;
const GABRIEL_ACTOR: SaleActor = { chatId: GROUP_CHAT_ID, userId: GABRIEL, name: 'Gabriel' };
const SMOKE_PHONE = '04248723454';
const SMOKE = `dame una cuenta nueva netflix por 30 dias Juan Diaz 4$ ${SMOKE_PHONE}`;
const FULL_COMBO =
  'vende un perfil de netflix para 4145460657 por 2 meses, pagó 8 USD por zelle, lo recibió Edward';

const SECRET = 'sale-iterative-test-secret-long';

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

async function fixtureWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-iterative-tool-'));
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
  scopedRemainder?: ScopedRemainderInterpreter,
): SaleDeps {
  return {
    store: saleStore,
    findCustomersByPhone: lookup,
    inventoryRows: rows,
    ...(scopedRemainder !== undefined ? { scopedRemainder } : {}),
  };
}

function countingRemainder(
  result: { field: string; value: string } | null,
): { calls: ScopedRemainderArgs[]; interpreter: ScopedRemainderInterpreter } {
  const calls: ScopedRemainderArgs[] = [];
  return {
    calls,
    interpreter: {
      interpretRemainder: async (args: ScopedRemainderArgs) => {
        calls.push(args);
        return result;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// T2: amount forms (parser units — the `4$` root fix)
// ---------------------------------------------------------------------------

describe('iterative parser: trailing/leading amount forms', () => {
  const cases: Array<[string, number, string]> = [
    ['cuenta 4$', 4, 'USD'],
    ['cuenta $4', 4, 'USD'],
    ['cuenta 4 usd', 4, 'USD'],
    ['cuenta 4 USD', 4, 'USD'],
    ['cuenta 4 dólares', 4, 'USD'],
    ['cuenta 4 dolares', 4, 'USD'],
    ['cuenta 4 usdt', 4, 'USDT'],
    ['cuenta 1800 bs', 1800, 'VES'],
    ['cuenta 1800 bolívares', 1800, 'VES'],
  ];
  for (const [text, amount, currency] of cases) {
    it(`(T2) "${text}" → ${amount} ${currency}`, () => {
      const extraction = parseSaleExtraction(text);
      expect(extraction.amount).toBe(amount);
      expect(extraction.amountCurrency).toBe(currency);
    });
  }
});

// ---------------------------------------------------------------------------
// T1/T4: one-message smoke — Juan Diaz + 4$ recovered, only method/receiver missing
// ---------------------------------------------------------------------------

describe('iterative tool: one-message fixed-point recovery', () => {
  it('(T1) Juan Diaz + 4$ recovered same-turn (unknown phone)', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      SMOKE,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.draft?.phone).toBe(SMOKE_PHONE);
    expect(result.draft?.customer.proposedCustomer).toMatchObject({
      name: 'Juan Diaz',
      phone: SMOKE_PHONE,
    });
    expect(result.draft?.duration.requestedMonths).toBe(1);
    expect(result.draft?.payment.actualAmount).toBe(4);
    expect(result.draft?.payment.currency).toBe('USD');
    expect(result.draft?.service).toBe('netflix');
    expect(result.draft?.modality).toBe('netflix-profile');
  });

  it('(T4) unknown-phone + name + amount → ONLY method/receiver missing', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      SMOKE,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('ask-missing');
    expect(result.missingFields).toEqual(['method', 'receiver']);
  });

  it('(T5) "Zelle, Edward" continuation → summary, same op', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw));
    const first = await prepareNewSaleFromText(GABRIEL_ACTOR, SMOKE, deps);
    const done = await prepareNewSaleFromText(GABRIEL_ACTOR, 'Zelle, Edward', deps);
    expect(done.kind).toBe('summary');
    expect(done.draft?.operationId).toBe(first.draft?.operationId);
    expect(done.draft?.payment.method).toBe('zelle');
    expect(done.draft?.payment.receivedBy).toBe('Edward');
    expect(done.draft?.customer.proposedCustomer?.name).toBe('Juan Diaz');
    expect(done.text).toContain('VENTA NUEVA');
  });

  it('(T6) full-turn known-phone combo → direct summary, existing identity wins', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const done = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      FULL_COMBO,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(done.kind).toBe('summary');
    expect(done.draft?.customer.existingCustomerId).toBeDefined();
    expect(done.draft?.customer.proposedCustomer).toBeUndefined();
    expect(done.draft?.payment.receivedBy).toBe('Edward');
  });

  it('(T11) receiver never defaulted: no holder evidence → receivedBy stays null', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      SMOKE,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.draft?.payment.receivedBy).toBeNull();
    // The customer name is never mistaken for the receiver.
    expect(result.draft?.payment.receivedBy).not.toBe('Juan Diaz');
  });
});

// ---------------------------------------------------------------------------
// T3: current-turn-only — no prior-turn leakage, no cross-op reuse
// ---------------------------------------------------------------------------

describe('iterative tool: current-turn conservation', () => {
  it('(T3a) name without a phone stays unconsumed (customer still missing)', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'dame una cuenta nueva netflix por 30 dias Juan Diaz 4$',
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    // Amount folds phone-independently; the name waits for dependent
    // state (a known phone) that this turn never provides.
    expect(result.draft?.payment.actualAmount).toBe(4);
    expect(result.draft?.customer.proposedCustomer).toBeUndefined();
    expect(result.missingFields).toContain('customer');
  });

  it('(T3b) prior-op fragments never leak into a fresh operation', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw));
    await prepareNewSaleFromText(GABRIEL_ACTOR, SMOKE, deps);
    await prepareNewSaleFromAction(GABRIEL_ACTOR, { type: 'cancel-sale' }, deps);
    const fresh = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `dame una cuenta nueva netflix por 30 dias 04149990001`,
      deps,
    );
    expect(fresh.draft?.customer.proposedCustomer).toBeUndefined();
    expect(fresh.draft?.phone).toBe('04149990001');
  });
});

// ---------------------------------------------------------------------------
// T7: lowercase location (HOTFIX 1 — supersedes lowercase-inert for
// LOCATION ONLY): a trailing `caracas` fills ONLY CUSTOMER_LOCATION —
// never name/method/receiver/amount, never blocking, never an extra
// turn. Non-location inert behavior is unchanged.
// ---------------------------------------------------------------------------

describe('iterative tool: lowercase location captured as place only', () => {
  it('(T7) trailing "caracas" fills ONLY the location, same missing, zero extra turns', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw));
    const plain = await prepareNewSaleFromText(GABRIEL_ACTOR, SMOKE, deps);
    await prepareNewSaleFromAction(GABRIEL_ACTOR, { type: 'cancel-sale' }, deps);
    const withCity = await prepareNewSaleFromText(GABRIEL_ACTOR, `${SMOKE} caracas`, deps);
    // Zero extra turns: the same fields are still missing (location is
    // never a missing field, never asked).
    expect(withCity.missingFields).toEqual(plain.missingFields);
    expect(withCity.missingFields).toEqual(['method', 'receiver']);
    expect(withCity.draft?.customer.proposedCustomer).toMatchObject({
      name: 'Juan Diaz',
      phone: SMOKE_PHONE,
    });
    // Case-insensitive classification, same semantic result as `Caracas`.
    expect(withCity.draft?.customer.proposedCustomer?.location?.city?.toLowerCase()).toBe(
      'caracas',
    );
    // Non-location contract holds: nothing else filled from the place.
    expect(withCity.draft?.customer.proposedCustomer?.name).toBe('Juan Diaz');
    expect(withCity.draft?.payment.receivedBy).toBeNull();
    expect(withCity.draft?.payment.actualAmount).toBe(4);
    expect(withCity.draft?.duration.requestedMonths).toBe(1);
    // The held location surfaces on the summary once the draft is ready
    // (ask-missing cards never display it — location adds zero turns).
    const done = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'Zelle, 4 dólares, lo recibió Edward',
      deps,
    );
    expect(done.kind).toBe('summary');
    expect(done.text).toContain('📍 Ubicación: caracas');
  });

  it('(T7b) combined smoke + redundant duration + caracas in ONE message', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw));
    const combined = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `${SMOKE} 1 mes caracas`,
      deps,
    );
    expect(combined.draft?.customer.proposedCustomer).toMatchObject({
      name: 'Juan Diaz',
      phone: SMOKE_PHONE,
    });
    expect(combined.draft?.customer.proposedCustomer?.location?.city?.toLowerCase()).toBe(
      'caracas',
    );
    expect(combined.draft?.duration.requestedMonths).toBe(1);
    expect(combined.draft?.payment.actualAmount).toBe(4);
    expect(combined.missingFields).toEqual(['method', 'receiver']);
  });
});

// ---------------------------------------------------------------------------
// T8: 30 días vs 1 mes under the CURRENT duration policy (no new policy)
// ---------------------------------------------------------------------------

describe('iterative tool: duration policy unchanged (30d ≈ 1mo rounded)', () => {
  it.each([
    ['dame una cuenta nueva netflix por 30 dias', 1],
    ['dame una cuenta nueva netflix por 1 mes', 1],
    ['dame una cuenta nueva netflix por 30 dias y 1 mes', 1],
  ])('(T8) "%s" → %i month(s)', async (text, months) => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      text,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.draft?.duration.requestedMonths).toBe(months);
  });
});

// ---------------------------------------------------------------------------
// T9: termination — noise never loops, genuine ambiguity asks
// ---------------------------------------------------------------------------

describe('iterative tool: bounded termination', () => {
  it('(T9) location-noise-only turn returns ask-missing (no loop, no fill)', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'dame cuenta netflix caracas caracas',
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('ask-missing');
    expect(result.draft?.phone).toBeNull();
    expect(result.draft?.customer.proposedCustomer).toBeUndefined();
    expect(result.missingFields).toContain('customer');
  });
});

// ---------------------------------------------------------------------------
// T10: scoped remainder contract — deterministic first, Gemini only on
// genuine ambiguity (counting stub proves both sides)
// ---------------------------------------------------------------------------

describe('iterative tool: scoped remainder escalation', () => {
  it('(T10a) smoke needs NO Gemini: deterministic covers everything (0 calls)', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const scoped = countingRemainder(null);
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      SMOKE,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw), scoped.interpreter),
    );
    expect(scoped.calls).toHaveLength(0);
    expect(result.missingFields).toEqual(['method', 'receiver']);
  });

  it('(T10b) genuinely-ambiguous leftover fires ONCE with the full contract', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const scoped = countingRemainder(null);
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `dame una cuenta nueva netflix por 30 dias ${SMOKE_PHONE} 4$ precio`,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw), scoped.interpreter),
    );
    expect(scoped.calls).toHaveLength(1);
    const args = scoped.calls[0] as ScopedRemainderArgs;
    expect(args.operation).toBe('NEW_SALE');
    expect(args.currentTurnOnly).toBe(true);
    expect(args.missing).toEqual(expect.arrayContaining(['customer', 'method', 'receiver']));
    expect(args.unconsumed).toEqual(['precio']);
    expect(args.allowed).toEqual(['customer', 'method', 'receiver', 'reference']);
    // Scoped call carries safe refs only — no phone, no credentials.
    expect(args.known).not.toHaveProperty('phone');
    // Null decision → settle asks instead (fail-closed).
    expect(result.kind).toBe('new-customer');
  });

  it('(T10c) scoped customer decision applies when fail-closed checks pass', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const scoped = countingRemainder({ field: 'customer', value: 'Ana Ruiz' });
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `dame una cuenta nueva netflix por 30 dias ${SMOKE_PHONE} 4$ precio`,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw), scoped.interpreter),
    );
    expect(scoped.calls).toHaveLength(1);
    expect(result.draft?.customer.proposedCustomer).toMatchObject({ name: 'Ana Ruiz' });
    expect(result.missingFields).toEqual(['method', 'receiver']);
  });

  it('(T10d) deterministic-only fields + unknown holders are rejected (fail-closed)', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const scopedAmount = countingRemainder({ field: 'amount', value: '999' });
    const attempt = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `dame una cuenta nueva netflix por 30 dias ${SMOKE_PHONE} 4$ precio`,
      toolDeps(
        saleStore,
        rows,
        (raw) => repos.searchCustomersByPhone(raw),
        scopedAmount.interpreter,
      ),
    );
    expect(attempt.draft?.payment.actualAmount).toBe(4);

    const saleStore2 = new NewSaleDraftStore();
    const scopedReceiver = countingRemainder({ field: 'receiver', value: 'Stranger' });
    const attempt2 = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `dame una cuenta nueva netflix por 30 dias ${SMOKE_PHONE} 4$ precio`,
      toolDeps(
        saleStore2,
        rows,
        (raw) => repos.searchCustomersByPhone(raw),
        scopedReceiver.interpreter,
      ),
    );
    expect(attempt2.draft?.payment.receivedBy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T12/T13: Volver ack ordering — answer BEFORE edit, same card, draft intact
// ---------------------------------------------------------------------------

interface CardPayload {
  chatId: number;
  text: string;
  replyMarkup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
  };
  messageThreadId?: number;
  messageId?: number;
}

type SentKind = 'send' | 'edit' | 'answer';

class StageClient implements TelegramClient {
  readonly sent: Array<{ kind: SentKind; payload: unknown }> = [];
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

  lastText(): string {
    const texts = this.sent
      .filter((entry) => entry.kind === 'send' || entry.kind === 'edit')
      .map((entry) => (entry.payload as CardPayload).text);
    return texts.at(-1) ?? '';
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

interface AckWorld {
  app: FastifyInstance;
  client: StageClient;
  saleDrafts: NewSaleDraftStore;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<void>;
}

async function createAckWorld(): Promise<AckWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-iterative-ack-'));
  const mockStore = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const reposStore = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'repos-state.json'),
  });
  const client = new StageClient();
  const saleDrafts = new NewSaleDraftStore();
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions: new SessionStore(),
    drafts: new DraftEngine(),
    interactions: new InteractionStore(),
    interpreter: new StubIntentInterpreter(),
    repos: new MockAccountRepositories(reposStore),
    client,
    sale: { saleDrafts, mockStore },
    alertsTopicId: 25,
  });
  let counter = 7200;
  return {
    app,
    client,
    saleDrafts,
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

describe('iterative webhook: Volver ack-first, same card', () => {
  it('(T12) Back answers BEFORE editing (exactly one answer — never double)', async () => {
    const world = await createAckWorld();
    await world.post(
      textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix por 30 dias'),
    );
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, '04149990001'));
    const volver = world.client.findButton('←Volver');
    expect(volver).toBeDefined();

    const before = world.client.sent.length;
    await world.post(tap(world.nextUpdateId(), GABRIEL, volver as string));
    const stages = world.client.sent.slice(before).map((entry) => entry.kind);
    // received → ack → edit: the receipt precedes ALL recompute/render/edit,
    // and the idempotent ack fires exactly once per callback.
    expect(stages).toEqual(['answer', 'edit']);
    await world.app.close();
  });

  it('(T13) Back still edits the SAME card with the draft intact', async () => {
    const world = await createAckWorld();
    await world.post(
      textMessage(world.nextUpdateId(), GABRIEL, 'dame una cuenta nueva netflix por 30 dias'),
    );
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, '04149990001'));
    const opBefore = world.saleDrafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.operationId;
    const volver = world.client.findButton('←Volver');
    await world.post(tap(world.nextUpdateId(), GABRIEL, volver as string));

    expect(world.client.sends()).toHaveLength(1);
    expect(world.client.lastText()).toContain('¿Qué operamos?');
    const draft = world.saleDrafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL });
    expect(draft?.operationId).toBe(opBefore);
    expect(draft?.phone).toBe('04149990001');
    expect(draft?.service).toBe('netflix');
    await world.app.close();
  });
});

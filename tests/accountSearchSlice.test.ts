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
import {
  AccountSelectionStore,
  formatAccountCard,
  groupRowsIntoAccounts,
} from '../src/mock/accounts';
import type { MockAccount } from '../src/mock/excelLoader';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';
import { callbackDataFor } from '../src/telegram/keyboards';

/**
 * Slice B — read-only account search (Netflix + FlujoTV, grouped
 * cards, selection context).
 *
 * REAL fixture values throughout: `dasdsadasda@gmail.com` = Netflix
 * ×4 profiles (Daniel pares / Rafael minnesota / Yuyu / Gloria
 * Castañeda), `cmaxnet001` = FlujoTV ×3 clients (Anny Tovar / Neisis
 * Zambrano / Roman Morales), `maxnet050` = FlujoTV CUENTA COMPLETA
 * (Jackson Amaya), `cmaxnet002` = FlujoTV ×3 incl. Nilson Zambrano
 * (legacy VENCIDO). The ONLY synthetic rows are the seeded Netflix
 * `cmaxnet001` duplicate proving multi-service disambiguation (the
 * fixture holds no identifier in both services) and the
 * legacy-DIAS/ESTATUS decoys proving derived status.
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

/** Pinned operational clock: the day the fixture was authored for. */
const PINNED_NOW = new Date('2026-09-06T12:00:00Z');

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

  answers(): Array<{ callbackQueryId: string; text?: string }> {
    return this.sent
      .filter((entry) => entry.kind === 'answer')
      .map((entry) => entry.payload as { callbackQueryId: string; text?: string });
  }

  messageCount(): number {
    return this.messages().length;
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

  lastButtons(): Array<{ text: string; callback_data: string }> {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      const entry = this.sent[index];
      if (entry === undefined || entry.kind === 'answer') {
        continue;
      }
      const payload = entry.payload as SentPayload;
      if (payload.replyMarkup !== undefined) {
        return payload.replyMarkup.inline_keyboard.flat();
      }
    }
    return [];
  }
}

interface AccountWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter;
  drafts: DraftEngine;
  interactions: InteractionStore;
  repos: MockAccountRepositories;
  store: MockStore;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

async function createAccountWorld(
  topics?: Map<number, number>,
  seed: MockAccount[] = [],
): Promise<AccountWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-acct-'));
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  for (const row of seed) {
    store.accounts.push(row);
  }
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
    store,
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

async function loadRepos(): Promise<MockAccountRepositories> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-acct-unit-'));
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  return new MockAccountRepositories(store);
}

function acctMessage(updateId: number, actorId: number, text: string, threadId?: number): unknown {
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

function acctCallback(updateId: number, actorId: number, data: string, threadId?: number): unknown {
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

/** Synthetic Netflix twin of the FlujoTV `cmaxnet001` account (TESTS ONLY). */
function seedNetflixCmaxnet001(): MockAccount {
  return {
    servicio: 'netflix',
    correo: 'cmaxnet001',
    contrasena: 'seed-secret-never-shown',
    perfil: '1 PERFIL (1)',
    fechaInicio: '2026-09-01',
    fechaFin: '2026-10-01',
    dias: null,
    estatus: 'VIGENTE',
    nombre: 'Seed Netflix Holder',
    monto: null,
    estado: '',
    numero: '4999999999',
    pais: 'US',
  };
}

function syntheticRow(overrides: Partial<MockAccount>): MockAccount {
  return {
    servicio: 'flujotv',
    correo: 'dup@example.com',
    contrasena: 'synthetic-secret',
    perfil: '1 PERFIL',
    fechaInicio: null,
    fechaFin: '2026-10-01',
    dias: 30,
    estatus: 'VIGENTE',
    nombre: 'Synthetic Holder',
    monto: null,
    estado: '',
    numero: '4999999999',
    pais: 'VE',
    ...overrides,
  };
}

/** The forbidden follow-ups: service choice, out-of-flow creation. */
const SERVICE_QUESTION_RE = /netflix o flujo|qu[eé] servicio|cu[aá]l servicio|elegir servicio|elige .*servicio/i;
const CREATE_CLIENT_RE = /crear cliente/i;

// ---------------------------------------------------------------------------
// Account identifier search (10–21)
// ---------------------------------------------------------------------------

describe('slice B: account identifier search (10–21)', () => {
  it('(10) a Netflix email groups its rows into ONE account', async () => {
    const repos = await loadRepos();
    const accounts = await repos.searchServiceAccounts('dasdsadasda@gmail.com');
    expect(accounts).toHaveLength(1);
    const account = accounts[0]!;
    expect(account.servicio).toBe('netflix');
    expect(account.identifier).toBe('dasdsadasda@gmail.com');
    expect(account.slots).toHaveLength(4);
    expect(account.slots.map((slot) => slot.cliente)).toEqual(
      expect.arrayContaining(['Daniel pares', 'Rafael minnesota', 'Yuyu', 'Gloria Castañeda']),
    );
  });

  it('(11) a FlujoTV username groups its rows into ONE account', async () => {
    const repos = await loadRepos();
    const accounts = await repos.searchServiceAccounts('cmaxnet001');
    expect(accounts).toHaveLength(1);
    const account = accounts[0]!;
    expect(account.servicio).toBe('flujotv');
    expect(account.slots).toHaveLength(3);
    expect(account.slots.map((slot) => slot.cliente)).toEqual(
      expect.arrayContaining(['Anny Tovar', 'Neisis Zambrano', 'Roman Morales']),
    );
  });

  it('(12) a maxnet050-class id resolves its CUENTA COMPLETA account', async () => {
    const repos = await loadRepos();
    const accounts = await repos.searchServiceAccounts('maxnet050');
    expect(accounts).toHaveLength(1);
    const account = accounts[0]!;
    expect(account.servicio).toBe('flujotv');
    expect(account.slots).toHaveLength(1);
    expect(account.slots[0]).toMatchObject({
      perfil: 'CUENTA COMPLETA',
      cliente: 'Jackson Amaya',
    });
  });

  it('(13) matching is case-insensitive and trims where applicable', async () => {
    const repos = await loadRepos();
    expect(await repos.searchServiceAccounts('  DASDSADASDA@GMAIL.COM  ')).toHaveLength(1);
    expect(await repos.searchServiceAccounts('  CMAXNET001 ')).toHaveLength(1);
    expect(await repos.searchServiceAccounts('MaxNet050')).toHaveLength(1);
  });

  it('(14) no domain is ever appended to a bare identifier', async () => {
    const repos = await loadRepos();
    expect(await repos.searchServiceAccounts('cmaxnet001@gmail.com')).toEqual([]);
    expect(await repos.searchServiceAccounts('maxnet050@outlook.com')).toEqual([]);
    expect(await repos.searchServiceAccounts('cmaxnet001@hotmail.com')).toEqual([]);
  });

  it('(15) email is never assumed to be Netflix — servicio comes from the row', async () => {
    const repos = await loadRepos();
    const netflix = await repos.searchServiceAccounts('dasdsadasda@gmail.com');
    expect(netflix[0]?.servicio).toBe('netflix');
    const flujo = await repos.searchServiceAccounts('cmaxnet001');
    expect(flujo[0]?.servicio).toBe('flujotv');
    // Both repositories are searched with no service hint: maxnet050 is
    // found in FlujoTV without ever asking "¿Netflix o FlujoTV?".
    const neutral = await repos.searchServiceAccounts('maxnet050');
    expect(neutral[0]?.servicio).toBe('flujotv');
  });

  it('(16) same-account rows stay grouped with per-row perfil/pais preserved', async () => {
    const repos = await loadRepos();
    const [account] = await repos.searchServiceAccounts('dasdsadasda@gmail.com');
    const daniel = account!.slots.find((slot) => slot.cliente === 'Daniel pares');
    // Per-row legacy spellings survive grouping: profile variant and the
    // BR account country of this row (phone 4121461745 is VE).
    expect(daniel).toMatchObject({ perfil: '1 PERFIL (1)', paisCuenta: 'BR' });
    expect(account!.slots.map((slot) => slot.perfil)).toEqual(
      expect.arrayContaining(['1 PERFIL (1)', '1 PERFIL (2)', '1 PERFIL (4)']),
    );
  });

  it('(17) one identifier in BOTH services yields N real accounts (TESTS ONLY seed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vokath-acct-dual-'));
    const store = await MockStore.create({
      fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
      statePath: join(dir, 'mock-state.json'),
    });
    store.accounts.push(seedNetflixCmaxnet001());
    const repos = new MockAccountRepositories(store);
    const accounts = await repos.searchServiceAccounts('cmaxnet001');
    expect(accounts).toHaveLength(2);
    expect(accounts.map((account) => account.servicio).sort()).toEqual(['flujotv', 'netflix']);
  });

  it('(18) unknown identifiers report empty without creating anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vokath-acct-unknown-'));
    const store = await MockStore.create({
      fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
      statePath: join(dir, 'mock-state.json'),
    });
    const before = store.accounts.length;
    const repos = new MockAccountRepositories(store);
    expect(await repos.searchServiceAccounts('cuenta-inexistente-999')).toEqual([]);
    expect(await repos.searchServiceAccounts('nadie@example.com')).toEqual([]);
    expect(store.accounts.length).toBe(before);
  });

  it('(19) empty or whitespace identifiers match nothing', async () => {
    const repos = await loadRepos();
    expect(await repos.searchServiceAccounts('')).toEqual([]);
    expect(await repos.searchServiceAccounts('   ')).toEqual([]);
  });

  it('(20) search is deterministic across both repositories with no service param', async () => {
    const repos = await loadRepos();
    const first = await repos.searchServiceAccounts('cmaxnet002');
    const second = await repos.searchServiceAccounts('cmaxnet002');
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]!.slots.map((slot) => slot.cliente)).toEqual(
      expect.arrayContaining(['Nilson Zambrano', 'Johnathan sobrino Dayana']),
    );
  });

  it('(21) exact matching only — no substring bleed between identifiers', async () => {
    const repos = await loadRepos();
    const bare = await repos.searchServiceAccounts('maxnet001');
    expect(bare).toHaveLength(1);
    expect(bare[0]!.identifier).toBe('maxnet001');
    const prefixed = await repos.searchServiceAccounts('cmaxnet001');
    expect(prefixed).toHaveLength(1);
    expect(prefixed[0]!.identifier).toBe('cmaxnet001');
  });
});

// ---------------------------------------------------------------------------
// Account cards (22–30)
// ---------------------------------------------------------------------------

describe('slice B: account cards (22–30)', () => {
  it('(22) a Netflix card shows the service, identifier and grouped profiles', async () => {
    const repos = await loadRepos();
    const [account] = await repos.searchServiceAccounts('dasdsadasda@gmail.com');
    const card = formatAccountCard(account!, PINNED_NOW);
    expect(card).toContain('📺 Netflix · dasdsadasda@gmail.com');
    for (const cliente of ['Daniel pares', 'Rafael minnesota', 'Yuyu', 'Gloria Castañeda']) {
      expect(card).toContain(cliente);
    }
    expect(card).toContain('1 PERFIL (1)');
    expect(card).toContain('vence 2026-09-27');
  });

  it('(23) a FlujoTV card keeps its OWN model — never the Netflix 5-profile shape', async () => {
    const repos = await loadRepos();
    const [account] = await repos.searchServiceAccounts('cmaxnet001');
    const card = formatAccountCard(account!, PINNED_NOW);
    expect(card).toContain('📺 FlujoTV · cmaxnet001');
    for (const cliente of ['Anny Tovar', 'Neisis Zambrano', 'Roman Morales']) {
      expect(card).toContain(cliente);
    }
    // Three shared `1 PERFIL` slots — no (1)..(5) profile numbering.
    expect(card.match(/1 PERFIL(?! \()/g)).toHaveLength(3);
  });

  it('(24) a CUENTA COMPLETA card is a single exclusive slot', async () => {
    const repos = await loadRepos();
    const [account] = await repos.searchServiceAccounts('maxnet050');
    const card = formatAccountCard(account!, PINNED_NOW);
    expect(card).toContain('📺 FlujoTV · maxnet050');
    expect(card).toContain('CUENTA COMPLETA — Jackson Amaya');
    expect(card.split('\n')).toHaveLength(2);
  });

  it('(25) PAIS_CUENTA is the service country — never the phone country', async () => {
    const repos = await loadRepos();
    const [netflix] = await repos.searchServiceAccounts('dasdsadasda@gmail.com');
    const netflixCard = formatAccountCard(netflix!, PINNED_NOW);
    // Daniel pares holds VE phone 4121461745 but his account country is BR.
    const danielLine = netflixCard.split('\n').find((line) => line.includes('Daniel pares')) ?? '';
    expect(danielLine).toContain('País cuenta: BR');
    const [flujo] = await repos.searchServiceAccounts('cmaxnet002');
    const flujoCard = formatAccountCard(flujo!, PINNED_NOW);
    // Johnathan sobrino Dayana holds US phone 18174487435 with no stored
    // account country — the card shows the gap, never a phone-derived one.
    const johnathanLine =
      flujoCard.split('\n').find((line) => line.includes('Johnathan sobrino Dayana')) ?? '';
    expect(johnathanLine).toContain('País cuenta: —');
  });

  it('(26) slot status is DERIVED from expiry with an injectable clock', async () => {
    const repos = await loadRepos();
    const [flujo] = await repos.searchServiceAccounts('cmaxnet001');
    const card = formatAccountCard(flujo!, PINNED_NOW);
    // Anny Tovar vence 2026-09-07: 1 día restante → Por vencer.
    expect(card).toMatch(/Anny Tovar — vence 2026-09-07 — Por vencer \(1 día\)/);
    const [netflix] = await repos.searchServiceAccounts('dasdsadasda@gmail.com');
    const netflixCard = formatAccountCard(netflix!, PINNED_NOW);
    // Daniel pares vence 2026-09-27: 21 días → Vigente.
    expect(netflixCard).toMatch(/Daniel pares — vence 2026-09-27 — Vigente \(21 días\)/);
    const [vencido] = await repos.searchServiceAccounts('cmaxnet002');
    const vencidoCard = formatAccountCard(vencido!, PINNED_NOW);
    // Nilson Zambrano vence 2026-09-02: −4 días → Vencido.
    expect(vencidoCard).toMatch(/Nilson Zambrano — vence 2026-09-02 — Vencido \(-4 días\)/);
  });

  it('(27) legacy DIAS/ESTATUS never govern the derived status (TESTS ONLY rows)', () => {
    const rows: MockAccount[] = [
      syntheticRow({
        correo: 'legacy@example.com',
        perfil: '1 PERFIL (1)',
        nombre: 'Stale Vigente',
        fechaFin: '2026-09-02',
        dias: 30,
        estatus: 'VIGENTE',
      }),
      syntheticRow({
        correo: 'legacy@example.com',
        perfil: '1 PERFIL (2)',
        nombre: 'Stale Vencido',
        fechaFin: '2026-10-04',
        dias: -99,
        estatus: 'VENCIDO',
      }),
    ];
    const [account] = groupRowsIntoAccounts(rows);
    const card = formatAccountCard(account!, PINNED_NOW);
    expect(card).toMatch(/Stale Vigente — vence 2026-09-02 — Vencido/);
    expect(card).toMatch(/Stale Vencido — vence 2026-10-04 — Vigente/);
  });

  it('(28) expired stays assigned — VENCIDO never reads as DISPONIBLE', async () => {
    const repos = await loadRepos();
    // maxnet001 is legacy VENCIDO (vence 2026-09-02) yet still assigned.
    const [account] = await repos.searchServiceAccounts('maxnet001');
    const card = formatAccountCard(account!, PINNED_NOW);
    expect(card).toContain('Jesus Galvis');
    expect(card).toMatch(/Vencido \(-4 días\)/);
    expect(card).not.toMatch(/disponible/i);
  });

  it('(29) cards never carry passwords, PINs or credentials', async () => {
    const world = await createAccountWorld();
    const netflixRows = world.store.searchByAccountIdentifier('dasdsadasda@gmail.com');
    const netflixSecret = netflixRows[0]?.contrasena ?? '';
    expect(netflixSecret).not.toBe('');
    const [netflix] = await world.repos.searchServiceAccounts('dasdsadasda@gmail.com');
    const netflixCard = formatAccountCard(netflix!, PINNED_NOW);
    expect(netflixCard).not.toContain(netflixSecret);
    const flujoRows = world.store.searchByAccountIdentifier('maxnet050');
    const flujoSecret = flujoRows[0]?.contrasena ?? '';
    expect(flujoSecret).not.toBe('');
    const [flujo] = await world.repos.searchServiceAccounts('maxnet050');
    expect(formatAccountCard(flujo!, PINNED_NOW)).not.toContain(flujoSecret);
    expect(JSON.stringify(netflixCard)).not.toMatch(/contrasena|CONTRASEÑA/i);
    await world.app.close();
  });

  it('(30) card relations bind every slot to the same account identity', async () => {
    const repos = await loadRepos();
    const [account] = await repos.searchServiceAccounts('cmaxnet001');
    expect(account!.slots).toHaveLength(3);
    for (const slot of account!.slots) {
      expect(slot.numeroRaw).not.toBe('');
    }
    const card = formatAccountCard(account!, PINNED_NOW);
    expect(card.split('\n')).toHaveLength(4);
    expect(card).not.toMatch(SERVICE_QUESTION_RE);
  });
});

// ---------------------------------------------------------------------------
// Account conversation (31–40)
// ---------------------------------------------------------------------------

describe('slice B: account conversation (31–40)', () => {
  it('(31) button flow input and parameterized NL end in the SAME account tool', async () => {
    const world = await createAccountWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchServiceAccounts');
    // Parameterized NL first.
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'busca maxnet050'));
    expect(world.interpreter.calls).toBe(0);
    expect(searchSpy).toHaveBeenCalledWith('maxnet050');
    expect(world.client.texts().at(-1)).toContain('Jackson Amaya');
    // Guided wizard: tap BUSCAR, then type the identifier bare.
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const buscar = world.client.findButton('🔎BUSCAR');
    if (buscar === undefined) {
      throw new Error('BUSCAR button missing');
    }
    await world.post(acctCallback(world.nextUpdateId(), GABRIEL, buscar));
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'maxnet050'));
    const calls = searchSpy.mock.calls.filter((call) => call[0] === 'maxnet050');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(world.client.texts().at(-1)).toContain('Jackson Amaya');
    await world.app.close();
  });

  it('(32) identifier present → direct card, zero Gemini, no follow-up question', async () => {
    const world = await createAccountWorld();
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'revísame una cuenta maxnet050'));
    expect(world.interpreter.calls).toBe(0);
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('📺 FlujoTV · maxnet050');
    expect(last).toContain('Jackson Amaya');
    expect(last).not.toMatch(SERVICE_QUESTION_RE);
    expect(last).not.toMatch(CREATE_CLIENT_RE);
    await world.app.close();
  });

  it('(33) identifier absent → asks ONLY for the identifier, zero repo calls', async () => {
    const world = await createAccountWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchServiceAccounts');
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'quiero revisar una cuenta'));
    expect(world.interpreter.calls).toBe(1);
    expect(searchSpy).not.toHaveBeenCalled();
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toMatch(/qué cuenta quieres revisar/i);
    expect(last).not.toMatch(SERVICE_QUESTION_RE);
    expect(last).not.toMatch(CREATE_CLIENT_RE);
    await world.app.close();
  });

  it('(34) unknown account → not-found + Buscar otra/Volver, never creation', async () => {
    const world = await createAccountWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchServiceAccounts');
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'busca cuenta-inexistente-999'));
    expect(searchSpy).toHaveBeenCalledWith('cuenta-inexistente-999');
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('🔎 Cuenta no encontrada');
    expect(last).toContain('No encontramos esa cuenta.');
    expect(world.client.findButton('🔎Buscar otra')).toBeDefined();
    expect(world.client.findButton('←Volver')).toBeDefined();
    expect(last).not.toMatch(CREATE_CLIENT_RE);
    expect(world.drafts.snapshot()).toHaveLength(0);
    await world.app.close();
  });

  it('(35) a single Netflix email opens its card directly, zero Gemini', async () => {
    const world = await createAccountWorld();
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'busca dasdsadasda@gmail.com'));
    expect(world.interpreter.calls).toBe(0);
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('📺 Netflix · dasdsadasda@gmail.com');
    for (const cliente of ['Daniel pares', 'Rafael minnesota', 'Yuyu', 'Gloria Castañeda']) {
      expect(last).toContain(cliente);
    }
    expect(world.client.findButton('🔎Buscar otra')).toBeDefined();
    await world.app.close();
  });

  it('(36) N real accounts → minimal disambiguation, then the selected card', async () => {
    const world = await createAccountWorld(undefined, [seedNetflixCmaxnet001()]);
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    expect(world.interpreter.calls).toBe(0);
    const list = world.client.texts().at(-1) ?? '';
    expect(list).toContain('2 cuentas comparten ese identificador');
    expect(list).not.toMatch(SERVICE_QUESTION_RE);
    const flujoBtn = world.client.findButton('1️⃣ FlujoTV · cmaxnet001');
    const netflixBtn = world.client.findButton('2️⃣ Netflix · cmaxnet001');
    if (flujoBtn === undefined || netflixBtn === undefined) {
      throw new Error('disambiguation buttons missing');
    }
    await world.post(acctCallback(world.nextUpdateId(), GABRIEL, netflixBtn));
    const card = world.client.texts().at(-1) ?? '';
    expect(card).toContain('📺 Netflix · cmaxnet001');
    expect(card).toContain('Seed Netflix Holder');
    // Volver from the card returns to the owned disambiguation list.
    const volver = world.client.findButton('←Volver');
    if (volver === undefined) {
      throw new Error('Volver button missing');
    }
    await world.post(acctCallback(world.nextUpdateId(), GABRIEL, volver));
    expect(world.client.texts().at(-1)).toContain('2 cuentas comparten ese identificador');
    await world.app.close();
  });

  it('(37) "buscar otra cuenta" re-enters the SAME guided wizard, zero Gemini', async () => {
    const world = await createAccountWorld();
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'busca maxnet050'));
    expect(world.client.texts().at(-1)).toContain('Jackson Amaya');
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'buscar otra cuenta'));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('🔎 BUSCAR');
    const prompts = world.interactions
      .snapshot()
      .filter(
        (interaction) =>
          interaction.type === 'SEARCH' &&
          interaction.status === 'PENDING' &&
          interaction.state['view'] === 'prompt',
      );
    expect(prompts).toHaveLength(1);
    await world.app.close();
  });

  it('(38) Gemini runs only when the identifier is missing', async () => {
    const world = await createAccountWorld();
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'busca maxnet050'));
    expect(world.interpreter.calls).toBe(0);
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'quiero revisar una cuenta'));
    expect(world.interpreter.calls).toBe(1);
    await world.app.close();
  });

  it('(39) the topic guard precedes parser/Gemini/tool on account NL', async () => {
    const topics = new Map<number, number>([
      [GABRIEL, THREAD_GABRIEL],
      [EDWARD, THREAD_EDWARD],
    ]);
    const world = await createAccountWorld(topics);
    const searchSpy = vi.spyOn(world.repos, 'searchServiceAccounts');
    await world.post(
      acctMessage(world.nextUpdateId(), GABRIEL, 'revísame una cuenta maxnet050', THREAD_EDWARD),
    );
    expect(world.interpreter.calls).toBe(0);
    expect(searchSpy).not.toHaveBeenCalled();
    expect(world.interactions.snapshot()).toHaveLength(0);
    expect(world.client.texts().at(-1)).toMatch(/pertenece/i);
    await world.app.close();
  });

  it('(40) ownership holds on every account callback (select, Buscar otra, Volver)', async () => {
    const world = await createAccountWorld(undefined, [seedNetflixCmaxnet001()]);
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    const edwardBtn = world.client.findButton('1️⃣ FlujoTV · cmaxnet001');
    if (edwardBtn === undefined) {
      throw new Error('disambiguation button missing');
    }
    const before = world.client.messageCount();
    const snapshotBefore = JSON.stringify(world.interactions.snapshot());
    // A peer tapping the disambiguation choice is rejected, changes nothing.
    await world.post(acctCallback(world.nextUpdateId(), EDWARD, edwardBtn));
    expect(world.client.answers().at(-1)?.text).toBe('Esta acción pertenece a Gabriel.');
    expect(world.client.messageCount()).toBe(before);
    expect(JSON.stringify(world.interactions.snapshot())).toBe(snapshotBefore);
    // A stale/forged view callback acks safely with no state change.
    const search = world.interactions
      .snapshot()
      .find(
        (interaction) =>
          interaction.ownerTelegramUserId === GABRIEL && interaction.type === 'SEARCH',
      );
    if (search === undefined) {
      throw new Error('SEARCH interaction missing');
    }
    await world.post(
      acctCallback(world.nextUpdateId(), GABRIEL, callbackDataFor('view0', 'deadbeef')),
    );
    expect(world.client.messageCount()).toBe(before);
    expect(JSON.stringify(world.interactions.snapshot())).toBe(snapshotBefore);
    await world.app.close();
  });
});

// ---------------------------------------------------------------------------
// Account multioperator (41–47)
// ---------------------------------------------------------------------------

describe('slice B: account multioperator (41–47)', () => {
  it('(41) result ownership: each actor opens their own disambiguation choice', async () => {
    const world = await createAccountWorld(undefined, [seedNetflixCmaxnet001()]);
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    const gabrielBtn = world.client.findButton('2️⃣ Netflix · cmaxnet001');
    if (gabrielBtn === undefined) {
      throw new Error('Gabriel disambiguation button missing');
    }
    await world.post(acctCallback(world.nextUpdateId(), GABRIEL, gabrielBtn));
    expect(world.client.texts().at(-1)).toContain('Seed Netflix Holder');

    await world.post(acctMessage(world.nextUpdateId(), EDWARD, 'cmaxnet001'));
    const edwardBtn = world.client.findButton('1️⃣ FlujoTV · cmaxnet001');
    if (edwardBtn === undefined) {
      throw new Error('Edward disambiguation button missing');
    }
    await world.post(acctCallback(world.nextUpdateId(), EDWARD, edwardBtn));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('Anny Tovar');
    expect(last).toContain('👤 Operador: Edward');
    await world.app.close();
  });

  it('(42) selection context is isolated per actor', async () => {
    const store = new AccountSelectionStore();
    const repos = await loadRepos();
    const [netflix] = await repos.searchServiceAccounts('dasdsadasda@gmail.com');
    const [flujo] = await repos.searchServiceAccounts('maxnet050');
    store.select(GROUP_CHAT_ID, GABRIEL, netflix!);
    store.select(GROUP_CHAT_ID, EDWARD, flujo!);
    // Reads stay served from the actor's own entry only, never a peer's.
    expect(store.lastSelected(GROUP_CHAT_ID, GABRIEL)?.identifier).toBe('dasdsadasda@gmail.com');
    expect(store.lastSelected(GROUP_CHAT_ID, EDWARD)?.identifier).toBe('maxnet050');

    // Webhook level: Edward's reference with no own context never leaks
    // Gabriel's searched account.
    const world = await createAccountWorld();
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'revísame maxnet050'));
    expect(world.client.texts().at(-1)).toContain('Jackson Amaya');
    await world.post(
      acctMessage(world.nextUpdateId(), EDWARD, 'esa misma, revísame cuándo vence'),
    );
    const edwardReply = world.client.texts().at(-1) ?? '';
    expect(edwardReply).not.toContain('Jackson Amaya');
    expect(edwardReply).toMatch(/🔎 BUSCAR|qu[ée] .*buscar|dato/i);
    await world.app.close();
  });

  it('(43) searches never touch drafts — an open draft survives search + Volver', async () => {
    const world = await createAccountWorld();
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'crea una prueba de 2 meses'));
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'busca maxnet050'));
    expect(world.client.texts().at(-1)).toContain('Jackson Amaya');
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    const volver = world.client.findButton('←Volver');
    if (volver === undefined) {
      throw new Error('Volver button missing');
    }
    await world.post(acctCallback(world.nextUpdateId(), GABRIEL, volver));
    expect(world.client.texts().at(-1)).toContain('🏠 Vokath');
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    await world.app.close();
  });

  it('(44) stale account callbacks ack safely with zero state change', async () => {
    const world = await createAccountWorld();
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'busca maxnet050'));
    const before = world.client.messageCount();
    const snapshotBefore = JSON.stringify(world.interactions.snapshot());
    await world.post(
      acctCallback(world.nextUpdateId(), GABRIEL, callbackDataFor('view4', 'deadbeef')),
    );
    expect(world.client.messageCount()).toBe(before);
    expect(JSON.stringify(world.interactions.snapshot())).toBe(snapshotBefore);
    await world.post(acctCallback(world.nextUpdateId(), GABRIEL, 'v1:stale-action'));
    expect(world.client.messageCount()).toBe(before);
    await world.app.close();
  });

  it('(45) "esa misma" resolves the actor own searched account', async () => {
    const world = await createAccountWorld();
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'revísame maxnet050'));
    expect(world.client.texts().at(-1)).toContain('Jackson Amaya');
    await world.post(
      acctMessage(world.nextUpdateId(), GABRIEL, 'esa misma, revísame cuándo vence'),
    );
    const gabrielReply = world.client.texts().at(-1) ?? '';
    expect(gabrielReply).toContain('📺 FlujoTV · maxnet050');
    expect(gabrielReply).toContain('Jackson Amaya');
    await world.app.close();
  });

  it('(46) an unknown search never touches the open draft', async () => {
    const world = await createAccountWorld();
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'crea una prueba de 2 meses'));
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'busca cuenta-inexistente-999'));
    expect(world.client.texts().at(-1)).toContain('🔎 Cuenta no encontrada');
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.months).toBe(2);
    await world.app.close();
  });

  it('(47) Volver from a single card lands Home — drafts and context survive', async () => {
    const world = await createAccountWorld();
    await world.post(acctMessage(world.nextUpdateId(), GABRIEL, 'busca maxnet050'));
    expect(world.client.texts().at(-1)).toContain('Jackson Amaya');
    const volver = world.client.findButton('←Volver');
    if (volver === undefined) {
      throw new Error('Volver button missing');
    }
    await world.post(acctCallback(world.nextUpdateId(), GABRIEL, volver));
    expect(world.client.texts().at(-1)).toContain('🏠 Vokath');
    // The SEARCH interaction kept its query: a later "esa misma" still
    // resolves the actor's own searched account.
    await world.post(
      acctMessage(world.nextUpdateId(), GABRIEL, 'esa misma, revísame cuándo vence'),
    );
    expect(world.client.texts().at(-1)).toContain('Jackson Amaya');
    await world.app.close();
  });
});

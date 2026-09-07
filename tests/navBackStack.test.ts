import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
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
import { callbackDataFor, type CallbackAction } from '../src/telegram/keyboards';
import { renderCredentialAssignmentList } from '../src/telegram/render';

/**
 * Navigation back-stack + fastest-datos + single-card + button-clarity
 * (presentation/navigation only — no business-rule changes).
 *
 * REAL fixture values: Anny Tovar (`4145460657`, FlujoTV `cmaxnet001`,
 * vence 2026-09-07); Jackson Amaya (`maxnet050` FlujoTV completa);
 * Rafael minnesota (`16124418159`, 4 bundles); Andrés pereira
 * (`maxnet003`, 2 ES numbers `34611161181`/`34641375927`).
 */

const GABRIEL = 1057242322;
const EDWARD = 941030473;
const GROUP_CHAT_ID = -1005550001;

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

const HOME_MARK = '🏠 Vokath';

interface SentButton {
  text: string;
  callback_data?: string;
  url?: string;
}

interface SentPayload {
  chatId: number;
  text: string;
  messageThreadId?: number;
  replyMarkup?: { inline_keyboard: SentButton[][] };
}

type SentEntry = { kind: 'send' | 'edit' | 'answer'; payload: unknown };

class StubTelegramClient implements TelegramClient {
  readonly sent: SentEntry[] = [];

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

  sendCount(): number {
    return this.sent.filter((entry) => entry.kind === 'send').length;
  }

  lastKind(): string {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      const entry = this.sent[index];
      if (entry !== undefined && entry.kind !== 'answer') {
        return entry.kind;
      }
    }
    return 'none';
  }

  messages(): SentPayload[] {
    return this.sent
      .filter((entry) => entry.kind === 'send' || entry.kind === 'edit')
      .map((entry) => entry.payload as SentPayload);
  }

  texts(): string[] {
    return this.messages().map((entry) => entry.text);
  }

  lastText(): string {
    return this.texts()[this.texts().length - 1] ?? '';
  }

  lastButtons(): SentButton[] {
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

  buttonData(text: string): string | undefined {
    return this.lastButtons().find((button) => button.text === text)?.callback_data;
  }

  lastUrlButton(): string | undefined {
    return this.lastButtons().find((button) => button.text === '💬 Abrir WhatsApp')?.url;
  }

  lastToast(): string | undefined {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      const entry = this.sent[index];
      if (entry?.kind === 'answer') {
        return (entry.payload as { text?: string }).text;
      }
    }
    return undefined;
  }
}

interface NavWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interactions: InteractionStore;
  drafts: DraftEngine;
  repos: MockAccountRepositories;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

async function createNavWorld(): Promise<NavWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-nav-'));
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const client = new StubTelegramClient();
  const interactions = new InteractionStore();
  const drafts = new DraftEngine();
  const repos = new MockAccountRepositories(store);
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions: new SessionStore(),
    drafts,
    interactions,
    interpreter: new StubIntentInterpreter(),
    repos,
    client,
    auditor: createAuditor(() => undefined),
  });
  let counter = 51000;
  return {
    app,
    client,
    interactions,
    drafts,
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

function navMessage(updateId: number, actorId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Operator' },
      chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
      text,
    },
  };
}

function navCallback(updateId: number, actorId: number, data: string): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Operator' },
      message: { message_id: 7, chat: { id: GROUP_CHAT_ID, type: 'supergroup' }, text: 'stub' },
      data,
    },
  };
}

function lastOwnedInteractionId(world: NavWorld): string {
  const owned = world.client.lastButtons().find((button) => button.callback_data !== undefined);
  return owned?.callback_data?.split(':')[2] ?? '';
}

async function tapView(world: NavWorld, actorId: number, index: number): Promise<void> {
  const data = callbackDataFor(`view${index}` as CallbackAction, lastOwnedInteractionId(world));
  await world.post(navCallback(world.nextUpdateId(), actorId, data));
}

async function tapButton(world: NavWorld, actorId: number, text: string): Promise<void> {
  const data = world.client.buttonData(text);
  expect(data).toBeDefined();
  await world.post(navCallback(world.nextUpdateId(), actorId, data as string));
}

async function searchRafaelSelect(world: NavWorld): Promise<void> {
  await world.post(navMessage(world.nextUpdateId(), GABRIEL, '16124418159'));
  const customers = await world.repos.searchCustomersByPhone('16124418159');
  const index = customers.findIndex((customer) => customer.nombre === 'Rafael minnesota');
  expect(index).toBeGreaterThanOrEqual(0);
  await tapView(world, GABRIEL, index);
  expect(world.client.lastText()).toContain('Rafael minnesota');
}

async function searchAnny(world: NavWorld): Promise<void> {
  await world.post(navMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
  expect(world.client.lastText()).toContain('Anny Tovar');
}

// ---------------------------------------------------------------------------
// Back-stack 1–8
// ---------------------------------------------------------------------------

describe('nav back-stack (1–8)', () => {
  it('(1) full chain: cliente → datos → tarjeta → Servicios → Volver ×4 reaches wizard then Home', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    expect(world.client.lastText()).toContain('¿Qué datos necesitas? (4)');
    await tapView(world, GABRIEL, 0);
    expect(world.client.lastText()).toContain('🔐 DATOS DE ACCESO');
    await tapButton(world, GABRIEL, '← Servicios');
    expect(world.client.lastText()).toContain('¿Qué datos necesitas? (4)');
    // Volver ×1 → credential card (exact previous view, never Home).
    await tapButton(world, GABRIEL, '←Volver');
    expect(world.client.lastText()).toContain('🔐 DATOS DE ACCESO');
    expect(world.client.lastText()).not.toContain(HOME_MARK);
    // Volver ×2 → selector again (round-trip preserves the stack).
    await tapButton(world, GABRIEL, '←Volver');
    expect(world.client.lastText()).toContain('¿Qué datos necesitas? (4)');
    expect(world.client.lastText()).not.toContain(HOME_MARK);
    // Volver ×3 → client card.
    await tapButton(world, GABRIEL, '←Volver');
    expect(world.client.lastText()).toContain('Rafael minnesota');
    expect(world.client.lastText()).not.toContain(HOME_MARK);
    // Volver ×4 → SEARCH_INPUT wizard (still not Home).
    await tapButton(world, GABRIEL, '←Volver');
    expect(world.client.lastText()).toContain('🔎 BUSCAR');
    expect(world.client.lastText()).not.toContain(HOME_MARK);
    await world.app.close();
  });

  it('(2) Volver never lands Home unless the parent is the root wizard', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapView(world, GABRIEL, 1);
    expect(world.client.lastText()).toContain('🔐 DATOS DE ACCESO');
    await tapButton(world, GABRIEL, '←Volver');
    expect(world.client.lastText()).not.toContain(HOME_MARK);
    // Root wizard Volver → Home is the single sanctioned parent case.
    await searchAnny(await createNavWorld()).catch(() => undefined);
    const root = await createNavWorld();
    await root.post(navMessage(root.nextUpdateId(), GABRIEL, '4145460657'));
    await tapButton(root, GABRIEL, '←Volver');
    await tapButton(root, GABRIEL, '←Volver');
    expect(root.client.lastText()).toContain(HOME_MARK);
    await world.app.close();
    await root.app.close();
  });

  it('(3) Servicios round-trips preserve the stack (card ⇄ selector ⇄ card)', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapView(world, GABRIEL, 2);
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    await tapButton(world, GABRIEL, '← Servicios');
    expect(world.client.lastText()).toContain('¿Qué datos necesitas? (4)');
    await tapView(world, GABRIEL, 2);
    expect(world.client.lastText()).toContain('🔐 DATOS DE ACCESO');
    await tapButton(world, GABRIEL, '←Volver');
    expect(world.client.lastText()).toContain('¿Qué datos necesitas? (4)');
    await tapButton(world, GABRIEL, '←Volver');
    expect(world.client.lastText()).toContain('🔐 DATOS DE ACCESO');
    await world.app.close();
  });

  it('(4) stale callbacks are safe/idempotent: no stack corruption, no Home, no selection change', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapView(world, GABRIEL, 0);
    expect(world.client.lastText()).toContain('🔐 DATOS DE ACCESO');
    const snapshotBefore = JSON.stringify(world.interactions.snapshot());
    const cardsBefore = world.client.messages().length;
    await world.post(navCallback(world.nextUpdateId(), GABRIEL, callbackDataFor('view1', 'deadbeef')));
    await world.post(navCallback(world.nextUpdateId(), GABRIEL, 'v1:stale-action'));
    expect(JSON.stringify(world.interactions.snapshot())).toBe(snapshotBefore);
    expect(world.client.messages().length).toBe(cardsBefore);
    expect(world.client.lastText()).toContain('🔐 DATOS DE ACCESO');
    expect(world.client.lastText()).not.toContain(HOME_MARK);
    // The owned selector still resolves after the stale taps.
    await tapButton(world, GABRIEL, '← Servicios');
    expect(world.client.lastText()).toContain('¿Qué datos necesitas? (4)');
    await world.app.close();
  });

  it('(5) per-actor stacks: a peer Volver is rejected and mutates nothing', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapView(world, GABRIEL, 0);
    expect(world.client.lastText()).toContain('🔐 DATOS DE ACCESO');
    const gabrielActive = world.interactions.getActive(GROUP_CHAT_ID, GABRIEL)?.id;
    const snapshotBefore = JSON.stringify(world.interactions.snapshot());
    const cardsBefore = world.client.messages().length;
    const volver = world.client.buttonData('←Volver');
    expect(volver).toBeDefined();
    await world.post(navCallback(world.nextUpdateId(), EDWARD, volver as string));
    expect(world.client.lastToast()).toContain('Gabriel');
    expect(world.client.messages().length).toBe(cardsBefore);
    expect(JSON.stringify(world.interactions.snapshot())).toBe(snapshotBefore);
    expect(world.interactions.getActive(GROUP_CHAT_ID, GABRIEL)?.id).toBe(gabrielActive);
    // Edward's own search starts an independent stack.
    await world.post(navMessage(world.nextUpdateId(), EDWARD, '4145460657'));
    expect(world.client.lastText()).toContain('Anny Tovar');
    await world.app.close();
  });

  it('(6) a new NL opens a new card but the old selector keeps working (stacks independent)', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const rafaId = lastOwnedInteractionId(world);
    expect(rafaId).not.toBe('');
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos maxnet050'));
    expect(world.client.lastText()).toContain('Jackson Amaya');
    const data = callbackDataFor('view1', rafaId);
    await world.post(navCallback(world.nextUpdateId(), GABRIEL, data));
    expect(world.client.lastKind()).toBe('edit');
    expect(world.client.lastText()).toContain('🔐 DATOS DE ACCESO');
    expect(world.client.lastText()).not.toContain(HOME_MARK);
    await world.app.close();
  });

  it('(7) NL "volver" pops the stack instead of jumping Home', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    expect(world.client.lastText()).toContain('¿Qué datos necesitas? (4)');
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'volver'));
    expect(world.client.lastText()).toContain('Rafael minnesota');
    expect(world.client.lastText()).not.toContain(HOME_MARK);
    await world.app.close();
  });

  it('(8) external pending drafts survive deep navigation + Volver cycles', async () => {
    const world = await createNavWorld();
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'crea una prueba de 2 meses'));
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapView(world, GABRIEL, 0);
    await tapButton(world, GABRIEL, '← Servicios');
    await tapButton(world, GABRIEL, '←Volver');
    await tapButton(world, GABRIEL, '←Volver');
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.months).toBe(2);
    await world.app.close();
  });
});

// ---------------------------------------------------------------------------
// Fast-data 9–15
// ---------------------------------------------------------------------------

describe('nav fast-data (9–15)', () => {
  it('(9) explicit identifier with one assignment renders the credential card DIRECTLY', async () => {
    const world = await createNavWorld();
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos maxnet050'));
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    expect(card).toContain('maxnet050');
    expect(card).toContain('Jackson Amaya');
    expect(card).not.toContain('¿Qué datos necesitas?');
    expect(world.client.messages()).toHaveLength(1);
    await world.app.close();
  });

  it('(10) single-assignment client: compact card + [Datos] reaches datos in 1 tap', async () => {
    const world = await createNavWorld();
    await searchAnny(world);
    expect(world.client.buttonData('🔐Datos')).toBeDefined();
    await tapButton(world, GABRIEL, '🔐Datos');
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    expect(card).toContain('Anny Tovar');
    expect(card).toContain('ncsa909');
    await world.app.close();
  });

  it('(11) multi-assignment FIRST card lists every assignment, no generic Datos step', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const card = world.client.lastText();
    expect(card).toContain('¿Qué datos necesitas? (4)');
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons.some((text) => text.includes('Netflix'))).toBe(true);
    expect(buttons.some((text) => text.includes('FlujoTV'))).toBe(true);
    expect(buttons.some((text) => text === '🔐Datos' || text === 'Datos')).toBe(false);
    await world.app.close();
  });

  it('(12) every assignment button resolves direct to its datos card', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapView(world, GABRIEL, 3);
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    expect(card).toContain('Rafael minnesota');
    expect(world.client.buttonData('← Servicios')).toBeDefined();
    await world.app.close();
  });

  it('(13) direct identifier auto-prepares WhatsApp with zero extra NL', async () => {
    const world = await createNavWorld();
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos maxnet050'));
    expect(world.client.lastText()).toContain('WhatsApp preparado');
    expect(world.client.lastUrlButton()).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    await world.app.close();
  });

  it('(14) single-assignment datos auto-includes WhatsApp (Anny, no extra step)', async () => {
    const world = await createNavWorld();
    await searchAnny(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    expect(world.client.lastText()).toContain('WhatsApp preparado');
    expect(world.client.lastUrlButton()).toMatch(/^https:\/\/wa\.me\/584145460657\?text=/);
    await world.app.close();
  });

  it('(15) multi-phone adds at most the single `¿A cuál número?` decision', async () => {
    const world = await createNavWorld();
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'maxnet003'));
    expect(world.client.lastText()).toContain('maxnet003');
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'prepárame el mensaje'));
    expect(world.client.lastText()).toContain('¿A cuál número?');
    expect(world.client.lastUrlButton()).toBeUndefined();
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons.some((text) => text.includes('34611161181'))).toBe(true);
    expect(buttons.some((text) => text.includes('34641375927'))).toBe(true);
    await tapView(world, GABRIEL, 1);
    expect(world.client.lastText()).toContain('WhatsApp preparado');
    expect(world.client.lastUrlButton()).toContain('wa.me/34641375927');
    await world.app.close();
  });
});

// ---------------------------------------------------------------------------
// Single-card 16–20
// ---------------------------------------------------------------------------

describe('nav single-card (16–20)', () => {
  it('(16) cliente → datos edits the SAME card (no new message)', async () => {
    const world = await createNavWorld();
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    expect(world.client.lastKind()).toBe('send');
    const sendsBefore = world.client.sendCount();
    await tapButton(world, GABRIEL, '🔐Datos');
    expect(world.client.sendCount()).toBe(sendsBefore);
    expect(world.client.lastKind()).toBe('edit');
    expect(world.client.lastText()).toContain('🔐 DATOS DE ACCESO');
    await world.app.close();
  });

  it('(17) selector → datos edits the SAME card (no new message)', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const sendsBefore = world.client.sendCount();
    await tapView(world, GABRIEL, 0);
    expect(world.client.sendCount()).toBe(sendsBefore);
    expect(world.client.lastKind()).toBe('edit');
    expect(world.client.lastText()).toContain('🔐 DATOS DE ACCESO');
    await world.app.close();
  });

  it('(18) Servicios restores the selector editing the SAME card', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapView(world, GABRIEL, 0);
    const sendsBefore = world.client.sendCount();
    await tapButton(world, GABRIEL, '← Servicios');
    expect(world.client.sendCount()).toBe(sendsBefore);
    expect(world.client.lastKind()).toBe('edit');
    expect(world.client.lastText()).toContain('¿Qué datos necesitas? (4)');
    await world.app.close();
  });

  it('(19) Volver re-renders editing the SAME card', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapView(world, GABRIEL, 0);
    const sendsBefore = world.client.sendCount();
    await tapButton(world, GABRIEL, '←Volver');
    expect(world.client.sendCount()).toBe(sendsBefore);
    expect(world.client.lastKind()).toBe('edit');
    expect(world.client.lastText()).not.toContain(HOME_MARK);
    await world.app.close();
  });

  it('(20) send-count stays frozen across the whole internal cycle', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const frozen = world.client.sendCount();
    await tapView(world, GABRIEL, 1);
    await tapButton(world, GABRIEL, '← Servicios');
    await tapView(world, GABRIEL, 1);
    await tapButton(world, GABRIEL, '←Volver');
    await tapButton(world, GABRIEL, '←Volver');
    expect(world.client.sendCount()).toBe(frozen);
    expect(world.client.lastText()).not.toContain(HOME_MARK);
    await world.app.close();
  });
});

// ---------------------------------------------------------------------------
// UI 21–24
// ---------------------------------------------------------------------------

describe('nav button clarity (21–24)', () => {
  it('(21) in-context buttons name the service, never a generic Datos', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons.some((text) => text.includes('Netflix'))).toBe(true);
    expect(buttons.some((text) => text.includes('FlujoTV'))).toBe(true);
    expect(buttons.some((text) => text === '🔐Datos' || text === 'Datos')).toBe(false);
    await world.app.close();
  });

  it('(22) no client-name repetition in context; disambiguation only adds short safe ids', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const card = world.client.lastText();
    expect(card).not.toContain('Rafael minnesota · Rafael minnesota');
    const buttons = world.client.lastButtons().map((button) => button.text);
    // Same-client collisions gain the short account id (cmaxnet002/cmaxnet004).
    expect(buttons.some((text) => text.includes('cmaxnet002'))).toBe(true);
    expect(buttons.some((text) => text.includes('cmaxnet004'))).toBe(true);
    // Button callbacks keep stable interaction-bound ids (64-byte cap).
    for (const button of world.client.lastButtons()) {
      if (button.callback_data !== undefined) {
        expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64);
      }
    }
    await world.app.close();
  });

  it('(23) empty fields are omitted, never `País: —`', async () => {
    const world = await createNavWorld();
    await searchRafaelSelect(world);
    await world.post(navMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const card = world.client.lastText();
    expect(card).not.toContain('País: —');
    expect(card).toContain('🌎 País: VE');
    await world.app.close();
  });

  it('(24) assignment blocks escape HTML in service, profile and disambiguator', async () => {
    const card = renderCredentialAssignmentList(1, [
      {
        numeral: '1️⃣',
        serviceLabel: 'Netflix',
        profile: '1 PERFIL <b>(1)</b>',
        disambiguator: 'cmax<script>net002',
        estatus: 'Vigente',
        dias: 41,
        fechaFin: '2026-10-17',
      },
    ]);
    expect(card).toContain('1 PERFIL &lt;b&gt;(1)&lt;/b&gt;');
    expect(card).toContain('cmax&lt;script&gt;net002');
    expect(card).not.toContain('<b>(1)</b>');
    expect(card).not.toContain('<script>');
  });
});

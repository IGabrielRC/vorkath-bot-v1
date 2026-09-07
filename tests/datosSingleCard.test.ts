import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  StubIntentInterpreter,
  type Intent,
  type SessionCtx,
} from '../src/ai/intentInterpreter';
import { createAuditor, type AuditEvent } from '../src/audit/audit';
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
import {
  formatExpiryLong,
  renderCredentialAssignmentList,
} from '../src/telegram/render';
import { renderCredentialWhatsAppText } from '../src/whatsapp/templates';

/**
 * Single-card datos UX: context precedence, idempotent reads, in-place
 * navigation, per-assignment first card, automatic WhatsApp, mandatory
 * expiry, central render rules, and Fase 1/2 regressions.
 *
 * REAL fixture values: Anny Tovar (`4145460657`, FlujoTV `cmaxnet001`,
 * `ncsa909`, vence 2026-09-07); Jackson Amaya (`maxnet050` FlujoTV
 * completa); Rafael minnesota (`16124418159`, 4 bundles: FlujoTV
 * `cmaxnet002`/`maxnet012`/`cmaxnet004` + Netflix `dasdsadasda@gmail.com`
 * vence 2026-10-17); Gloria Castañeda (Netflix, vence 2026-10-03);
 * Andrés pereira (`maxnet003`, 2 ES numbers).
 */

const GABRIEL = 1057242322;
const EDWARD = 941030473;
const GROUP_CHAT_ID = -1005550001;
const T_GABRIEL = 101;

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

const DENY_PASSWORDS = ['simara23075', 'ncsa909', 'hjdksa989', 'asdd76', 'sasdas09'];
const HOME_MARK = '🏠 Vokath';
const UNKNOWN_MARK = '❓ No entendí';

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

  cardCount(): number {
    return this.sent.filter((entry) => entry.kind === 'send' || entry.kind === 'edit').length;
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
}

class RecordingInterpreter extends StubIntentInterpreter {
  readonly seenTexts: string[] = [];

  override async interpret(text: string, ctx: SessionCtx): Promise<Intent> {
    this.seenTexts.push(text);
    return super.interpret(text, ctx);
  }
}

interface DatosWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: RecordingInterpreter;
  interactions: InteractionStore;
  drafts: DraftEngine;
  repos: MockAccountRepositories;
  audits: AuditEvent[];
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

async function createDatosWorld(opts?: { topics?: Map<number, number> }): Promise<DatosWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-datos-'));
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const client = new StubTelegramClient();
  const interpreter = new RecordingInterpreter();
  const interactions = new InteractionStore();
  const drafts = new DraftEngine();
  const repos = new MockAccountRepositories(store);
  const audits: AuditEvent[] = [];
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions: new SessionStore(),
    drafts,
    interactions,
    interpreter,
    repos,
    client,
    auditor: createAuditor((event) => {
      audits.push(event);
    }),
    ...(opts?.topics !== undefined ? { operatorTopics: opts.topics } : {}),
  });
  let counter = 31000;
  return {
    app,
    client,
    interpreter,
    interactions,
    drafts,
    repos,
    audits,
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

function datosMessage(updateId: number, actorId: number, text: string, threadId?: number): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Operator' },
      chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
      text,
    },
  };
}

function datosCallback(updateId: number, actorId: number, data: string, threadId?: number): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Operator' },
      message: {
        message_id: 7,
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
        chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
        text: 'stub',
      },
      data,
    },
  };
}

function lastOwnedInteractionId(world: DatosWorld): string {
  const owned = world.client.lastButtons().find((button) => button.callback_data !== undefined);
  return owned?.callback_data?.split(':')[2] ?? '';
}

async function tapView(world: DatosWorld, actorId: number, index: number): Promise<void> {
  const data = callbackDataFor(`view${index}` as CallbackAction, lastOwnedInteractionId(world));
  await world.post(datosCallback(world.nextUpdateId(), actorId, data));
}

async function tapButton(world: DatosWorld, actorId: number, text: string): Promise<void> {
  const data = world.client.buttonData(text);
  expect(data).toBeDefined();
  await world.post(datosCallback(world.nextUpdateId(), actorId, data as string));
}

async function searchPhoneSelect(
  world: DatosWorld,
  actorId: number,
  phone: string,
  name: string,
): Promise<void> {
  await world.post(datosMessage(world.nextUpdateId(), actorId, phone));
  const customers = await world.repos.searchCustomersByPhone(phone);
  if (customers.length > 1) {
    const index = customers.findIndex((customer) => customer.nombre === name);
    expect(index).toBeGreaterThanOrEqual(0);
    await tapView(world, actorId, index);
  } else {
    expect(customers[0]?.nombre).toBe(name);
  }
}

function stripOperatorLabel(text: string): string {
  return text.replace(/\n👤 Operador: [^\n]*$/, '');
}

// ---------------------------------------------------------------------------
// Precedence 1–4: explicit current-message identifier wins
// ---------------------------------------------------------------------------

describe('datos precedence (1–4)', () => {
  it('(1) explicit account id beats prior operator context (cmaxnet001 → maxnet050)', async () => {
    const world = await createDatosWorld();
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    expect(world.client.lastText()).toContain('cmaxnet001');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos maxnet050'));
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    expect(card).toContain('maxnet050');
    expect(card).toContain('Jackson Amaya');
    expect(card).not.toContain('cmaxnet001');
    expect(card).not.toContain('Anny Tovar');
  });

  it('(2) explicit email beats the interaction selection (Anny → dasdsadasda)', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(
      datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos dasdsadasda@gmail.com'),
    );
    const card = world.client.lastText();
    expect(card).toContain('¿Qué datos necesitas? (4)');
    expect(card).toContain('Gloria Castañeda');
    expect(card).not.toContain('Anny Tovar');
    expect(card).not.toContain('ncsa909');
  });

  it('(3) the new resolution becomes the operator context for bare repeats', async () => {
    const world = await createDatosWorld();
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos maxnet050'));
    expect(world.client.lastText()).toContain('Jackson Amaya');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const card = world.client.lastText();
    expect(card).toContain('Jackson Amaya');
    expect(card).toContain('maxnet050');
  });

  it('(4) explicit shared phone beats stored account context (cmaxnet001 → Gloria)', async () => {
    const world = await createDatosWorld();
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos 4243764828'));
    const card = world.client.lastText();
    expect(card).toContain('Gloria Castañeda');
    expect(card).not.toContain('Anny Tovar');
    expect(card).not.toContain('ncsa909');
  });
});

// ---------------------------------------------------------------------------
// Idempotency 5–8: repeats return the same logical result
// ---------------------------------------------------------------------------

describe('datos idempotency (5–8)', () => {
  it('(5) repeating SHOW_CREDENTIALS N× returns the same card, never Home/UNKNOWN', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    const seen: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
      const card = stripOperatorLabel(world.client.lastText());
      expect(card).toContain('🔐 DATOS DE ACCESO');
      expect(card).toContain('simara23075');
      expect(card).not.toContain(HOME_MARK);
      expect(card).not.toContain(UNKNOWN_MARK);
      seen.push(card);
    }
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
  });

  it('(6) repeating PREPARE_WHATSAPP N× returns the same card and URL', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    const seen: Array<{ text: string; url?: string }> = [];
    for (let round = 0; round < 2; round += 1) {
      await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp'));
      seen.push({ text: stripOperatorLabel(world.client.lastText()), url: world.client.lastUrlButton() });
    }
    expect(seen[0]?.text).toContain('WhatsApp preparado');
    expect(seen[1]?.text).toBe(seen[0]?.text);
    expect(seen[0]?.url).toMatch(/^https:\/\/wa\.me\/584145460657\?text=/);
    expect(seen[1]?.url).toBe(seen[0]?.url);
  });

  it('(7) repeating an explicit-identifier read is stable too', async () => {
    const world = await createDatosWorld();
    const seen: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos maxnet050'));
      seen.push(stripOperatorLabel(world.client.lastText()));
    }
    expect(seen[0]).toContain('Jackson Amaya');
    expect(seen[1]).toBe(seen[0]);
  });

  it('(8) repeats never draft, never degrade: no drafts, no Home, no stale', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp'));
    expect(world.drafts.snapshot()).toHaveLength(0);
    for (const text of world.client.texts()) {
      expect(text).not.toContain(HOME_MARK);
      expect(text).not.toContain(UNKNOWN_MARK);
      expect(text).not.toContain('📝');
    }
  });
});

// ---------------------------------------------------------------------------
// Single-card navigation 9–13
// ---------------------------------------------------------------------------

describe('datos single-card navigation (9–13)', () => {
  it('(9) phone card → Datos edits the SAME card (no new message)', async () => {
    const world = await createDatosWorld();
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    expect(world.client.lastKind()).toBe('send');
    const sendsBefore = world.client.sendCount();
    await tapButton(world, GABRIEL, '🔐Datos');
    expect(world.client.sendCount()).toBe(sendsBefore);
    expect(world.client.lastKind()).toBe('edit');
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    expect(card).toContain('ncsa909');
    expect(world.client.lastUrlButton()).toMatch(/^https:\/\/wa\.me\/584145460657\?text=/);
  });

  it('(10) multi-assignment selection edits the SAME card into datos+WhatsApp+Servicios', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    expect(world.client.lastText()).toContain('¿Qué datos necesitas? (4)');
    const sendsBefore = world.client.sendCount();
    await tapView(world, GABRIEL, 0);
    expect(world.client.sendCount()).toBe(sendsBefore);
    expect(world.client.lastKind()).toBe('edit');
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    expect(card).toContain('Rafael minnesota');
    expect(world.client.lastUrlButton()).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    expect(world.client.buttonData('← Servicios')).toBeDefined();
  });

  it('(11) [← Servicios] restores the selector card in place', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapView(world, GABRIEL, 0);
    expect(world.client.lastText()).toContain('🔐 DATOS DE ACCESO');
    const sendsBefore = world.client.sendCount();
    await tapButton(world, GABRIEL, '← Servicios');
    expect(world.client.sendCount()).toBe(sendsBefore);
    expect(world.client.lastKind()).toBe('edit');
    expect(world.client.lastText()).toContain('¿Qué datos necesitas? (4)');
  });

  it('(12) [← Volver] pops the nav stack: single card → wizard, selector → client card', async () => {
    const single = await createDatosWorld();
    await searchPhoneSelect(single, GABRIEL, '4145460657', 'Anny Tovar');
    await single.post(datosMessage(single.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapButton(single, GABRIEL, '←Volver');
    // Exact previous view of the SAME interaction (client card), never Home.
    expect(single.client.lastText()).toContain('Anny Tovar');
    expect(single.client.lastText()).not.toContain(HOME_MARK);
    expect(single.client.lastText()).not.toContain('🔐 DATOS DE ACCESO');

    const multi = await createDatosWorld();
    await searchPhoneSelect(multi, GABRIEL, '16124418159', 'Rafael minnesota');
    await multi.post(datosMessage(multi.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapButton(multi, GABRIEL, '←Volver');
    // Selector pops to the client card it came from — never Home.
    expect(multi.client.lastText()).toContain('Rafael minnesota');
    expect(multi.client.lastText()).not.toContain(HOME_MARK);
  });

  it('(13) a new NL opens a new card but the old selector keeps working', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const rafaId = lastOwnedInteractionId(world);
    expect(rafaId).not.toBe('');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos maxnet050'));
    expect(world.client.lastKind()).toBe('send');
    expect(world.client.lastText()).toContain('Jackson Amaya');
    const data = callbackDataFor('view1' as CallbackAction, rafaId);
    await world.post(datosCallback(world.nextUpdateId(), GABRIEL, data));
    expect(world.client.lastKind()).toBe('edit');
    expect(world.client.lastText()).toContain('🔐 DATOS DE ACCESO');
  });
});

// ---------------------------------------------------------------------------
// Button labels 14–16
// ---------------------------------------------------------------------------

describe('datos button labels (14–16)', () => {
  it('(14) multi-assignment buttons name real services, never a generic Datos', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons.some((text) => text.includes('Netflix'))).toBe(true);
    expect(buttons.some((text) => text.includes('FlujoTV'))).toBe(true);
    expect(buttons.some((text) => text === '🔐Datos' || text === 'Datos')).toBe(false);
  });

  it('(15) similar assignments are disambiguated with a short safe identifier', async () => {
    const world = await createDatosWorld();
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    await tapButton(world, GABRIEL, '🔐Datos');
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons.some((text) => text.includes('Anny Tovar'))).toBe(true);
    expect(buttons.some((text) => text.includes('Neisis Zambrano'))).toBe(true);
    expect(buttons.some((text) => text.includes('Roman Morales'))).toBe(true);
    const twin = await createDatosWorld();
    await searchPhoneSelect(twin, GABRIEL, '16124418159', 'Rafael minnesota');
    await twin.post(datosMessage(twin.nextUpdateId(), GABRIEL, 'dame los datos'));
    const twinButtons = twin.client.lastButtons().map((button) => button.text);
    expect(twinButtons.some((text) => text.includes('cmaxnet002'))).toBe(true);
    expect(twinButtons.some((text) => text.includes('cmaxnet004'))).toBe(true);
  });

  it('(16) single-assignment datos: WhatsApp auto-button, no Servicios', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    expect(world.client.lastUrlButton()).toMatch(/^https:\/\/wa\.me\/584145460657\?text=/);
    expect(world.client.buttonData('← Servicios')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Auto-WhatsApp 17–20
// ---------------------------------------------------------------------------

describe('datos auto-WhatsApp (17–20)', () => {
  it('(17) datos auto-includes the WhatsApp button when unambiguous (Anny)', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const card = world.client.lastText();
    expect(card).toContain('WhatsApp preparado');
    expect(world.client.lastUrlButton()).toMatch(/^https:\/\/wa\.me\/584145460657\?text=/);
  });

  it('(18) datos auto-includes the WhatsApp button (Gloria Netflix, no extra NL)', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    expect(world.client.lastUrlButton()).toMatch(/^https:\/\/wa\.me\/584243764828\?text=/);
  });

  it('(19) ambiguous multi-phone stays button-less until the number is chosen', async () => {
    const world = await createDatosWorld();
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'maxnet003'));
    expect(world.client.lastText()).toContain('maxnet003');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'prepárame el mensaje'));
    expect(world.client.lastText()).toContain('¿A cuál número?');
    expect(world.client.lastUrlButton()).toBeUndefined();
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons.some((text) => text.includes('34611161181'))).toBe(true);
    expect(buttons.some((text) => text.includes('34641375927'))).toBe(true);
    await tapView(world, GABRIEL, 1);
    expect(world.client.lastText()).toContain('WhatsApp preparado');
    expect(world.client.lastUrlButton()).toContain('wa.me/34641375927');
  });

  it('(20) the wa.me payload carries the template with expiry', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const url = world.client.lastUrlButton() as string;
    const text = decodeURIComponent(url.split('?text=')[1] ?? '');
    expect(text).toContain('Anny Tovar');
    expect(text).toContain('ncsa909');
    expect(text).toMatch(/Vence: \d{1,2} de \w+ de \d{4}/);
  });
});

// ---------------------------------------------------------------------------
// Expiry 21–27
// ---------------------------------------------------------------------------

describe('datos expiry in template (21–27)', () => {
  it('(21) the template carries the SELECTED assignment expiry (Rafael Netflix)', async () => {
    const bundles = await (await createDatosWorld()).repos.getCredentialBundlesForCustomer(
      'rafael minnesota',
    );
    const netflix = bundles.find((bundle) => bundle.service === 'netflix');
    expect(netflix?.fechaFin).toBe('2026-10-17');
    expect(renderCredentialWhatsAppText(netflix!)).toContain('17 de octubre de 2026');
  });

  it('(22) never another assignment expiry in the same template', async () => {
    const world = await createDatosWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('rafael minnesota');
    const netflix = bundles.find((bundle) => bundle.service === 'netflix');
    const text = renderCredentialWhatsAppText(netflix!);
    expect(text).not.toContain('30 de agosto de 2027');
    expect(text).not.toContain('19 de septiembre de 2026');
    expect(text).not.toContain('18 de septiembre de 2027');
  });

  it('(23) never legacy DIAS, always the long format', async () => {
    const world = await createDatosWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('anny tovar');
    const text = renderCredentialWhatsAppText(bundles[0]!);
    expect(text).toMatch(/📅 Vence: \d{1,2} de \w+ de \d{4}/);
    expect(text).toContain('7 de septiembre de 2026');
  });

  it('(24) invalid expiry renders the explicit gap, never a fake date', async () => {
    expect(formatExpiryLong(null)).toBeNull();
    expect(formatExpiryLong('')).toBeNull();
    expect(formatExpiryLong('no-fecha')).toBeNull();
    expect(formatExpiryLong('2026-13-40')).toBeNull();
    const world = await createDatosWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('anny tovar');
    const broken = { ...bundles[0]!, fechaFin: null };
    expect(renderCredentialWhatsAppText(broken)).toContain('sin fecha registrada');
  });

  it('(25) central long format is copy-stable Spanish', async () => {
    expect(formatExpiryLong('2026-09-18')).toBe('18 de septiembre de 2026');
    expect(formatExpiryLong('2027-01-20')).toBe('20 de enero de 2027');
    expect(formatExpiryLong('2026-10-03')).toBe('3 de octubre de 2026');
  });

  it('(26) the Telegram datos card shows the assignment expiry', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    expect(world.client.lastText()).toContain('Vence: 7 de septiembre de 2026');
  });

  it('(27) template copy stays swappable through the central registry', async () => {
    const world = await createDatosWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('anny tovar');
    const custom = {
      'credentials.netflix': () => 'NETFLIX-CUSTOM',
      'credentials.flujotv.shared': () => 'FLUJO-CUSTOM',
      'credentials.flujotv.complete': () => 'COMPLETE-CUSTOM',
    };
    expect(renderCredentialWhatsAppText(bundles[0]!, custom)).toBe('FLUJO-CUSTOM');
  });
});

// ---------------------------------------------------------------------------
// Render rules 28–32 (central render.ts only)
// ---------------------------------------------------------------------------

describe('datos render rules (28–32)', () => {
  it('(28) title bold with blank-line blocks', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const card = world.client.lastText();
    expect(card).toContain('<b>🔐 ¿Qué datos necesitas? (4)</b>\nElige una opción:');
    expect(card).toContain('\n\n1️⃣');
  });

  it('(29) short lines, no giant dash-chains', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const body = stripOperatorLabel(world.client.lastText());
    for (const line of body.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    expect(body).not.toContain('——');
    expect(body).not.toMatch(/ — .* — .* — /);
  });

  it('(30) empty country omitted, present country kept (never `País: —`)', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const card = world.client.lastText();
    expect(card).not.toContain('País: —');
    // Two Rafael assignments carry PAIS_CUENTA VE (shown), two carry ''
    // (omitted) — country appears only when present.
    expect(card).toContain('🌎 País: VE');
  });

  it('(31) human dates and consistent statuses, no legacy shout', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const card = world.client.lastText();
    expect(card).toContain('Vigente');
    expect(card).toContain('Vence:');
    expect(card).not.toContain('VIGENTE');
    expect(card).not.toContain('POR VENCER');
  });

  it('(32) HTML escaping stays intact in assignment blocks', async () => {
    const card = renderCredentialAssignmentList(1, [
      {
        numeral: '1️⃣',
        serviceLabel: 'Netflix',
        profile: '1 PERFIL <b>(1)</b>',
        estatus: 'Vigente',
        dias: 41,
        fechaFin: '2026-10-17',
      },
    ]);
    expect(card).toContain('1 PERFIL &lt;b&gt;(1)&lt;/b&gt;');
    expect(card).not.toContain('1 PERFIL <b>(1)</b>');
  });
});

// ---------------------------------------------------------------------------
// Regressions: Fase 1/2 untouched
// ---------------------------------------------------------------------------

describe('datos regressions (Fase 1/2 intact)', () => {
  it('(R1) normal search never shows the sensitive card or secrets', async () => {
    const world = await createDatosWorld();
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    for (const text of world.client.texts()) {
      expect(text).not.toContain('🔐 DATOS DE ACCESO');
      for (const password of DENY_PASSWORDS) {
        expect(text).not.toContain(password);
      }
    }
  });

  it('(R2) datos flows never touch drafts', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapView(world, GABRIEL, 0);
    await tapButton(world, GABRIEL, '← Servicios');
    await tapView(world, GABRIEL, 1);
    expect(world.drafts.snapshot()).toHaveLength(0);
  });

  it('(R3) Gemini never receives credentials or PINs', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapView(world, GABRIEL, 0);
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos maxnet050'));
    // L3 semantic variant (falls through L2): the model sees intent text only.
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, '¿qué clave tiene esa cuenta?'));
    expect(world.interpreter.seenTexts.length).toBeGreaterThan(0);
    const seen = world.interpreter.seenTexts.join('\n');
    for (const password of DENY_PASSWORDS) {
      expect(seen).not.toContain(password);
    }
    expect(seen).not.toMatch(/🔒 PIN/);
  });

  it('(R4) audits carry safe refs only — no passwords, no PINs', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapView(world, GABRIEL, 0);
    const blob = JSON.stringify(world.audits);
    for (const password of DENY_PASSWORDS) {
      expect(blob).not.toContain(password);
    }
    expect(blob).not.toContain('🔒 PIN');
  });

  it('(R5) a peer tapping Servicios is rejected and changes nothing', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await tapView(world, GABRIEL, 0);
    const data = world.client.buttonData('← Servicios');
    expect(data).toBeDefined();
    const cardsBefore = world.client.cardCount();
    await world.post(datosCallback(world.nextUpdateId(), EDWARD, data as string));
    expect(world.client.cardCount()).toBe(cardsBefore);
    expect(world.client.lastText()).toContain('🔐 DATOS DE ACCESO');
  });

  it('(R6) per-actor isolation: a bare repeat by a peer with no context asks, never leaks', async () => {
    const world = await createDatosWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    expect(world.client.lastText()).toContain('¿Qué datos necesitas? (4)');
    await world.post(datosMessage(world.nextUpdateId(), EDWARD, 'dame los datos'));
    // The no-context guide (safe: no passwords, no PIN, no client data).
    const reply = world.client.lastText();
    expect(reply).toContain('Primero busca');
    expect(reply).not.toContain('Rafael minnesota');
    expect(reply).not.toContain('Contraseña');
    expect(reply).not.toMatch(/PIN:/);
    for (const password of DENY_PASSWORDS) {
      expect(reply).not.toContain(password);
    }
  });

  it('(R7) topics: General/foreign replies never carry credentials', async () => {
    const world = await createDatosWorld({
      topics: new Map([
        [GABRIEL, T_GABRIEL],
        [EDWARD, 202],
      ]),
    });
    await world.post(datosMessage(world.nextUpdateId(), GABRIEL, 'dame los datos', T_GABRIEL));
    const generalReply = world.client.lastText();
    for (const password of DENY_PASSWORDS) {
      expect(generalReply).not.toContain(password);
    }
    expect(generalReply).not.toContain('Contraseña');
    expect(generalReply).not.toMatch(/PIN:/);
  });
});

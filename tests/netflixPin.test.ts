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
import { buildCredentialBundles } from '../src/mock/credentials';
import type { MockAccount } from '../src/mock/excelLoader';
import { MockStore } from '../src/mock/mockStore';
import {
  deriveNetflixProfilePin,
  resolveNetflixPin,
  singleUsableIdentity,
} from '../src/mock/netflixPin';
import { identifyPhone } from '../src/mock/phone';
import { MockAccountRepositories } from '../src/mock/repositories';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';
import { callbackDataFor, type CallbackAction } from '../src/telegram/keyboards';
import { renderCredentialWhatsAppText } from '../src/whatsapp/templates';

/**
 * Netflix profile-PIN rule: PIN = last 4 digits of the phone truly
 * belonging to THAT assignment, derived centrally, never persisted,
 * never outside the explicit datos card / credentials.netflix template.
 *
 * REAL fixture values: Gloria (`4243764828` → `4828`), Rafael
 * (`16124418159` → `8159`), Daniel pares (`4121461745` → `1745`),
 * Yuyu (`4141479085` → `9085`), Anny Tovar (`4145460657` → `0657`
 * reference for format invariance).
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

interface PinWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: RecordingInterpreter;
  interactions: InteractionStore;
  repos: MockAccountRepositories;
  audits: AuditEvent[];
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

async function createPinWorld(opts?: { topics?: Map<number, number> }): Promise<PinWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-pin-'));
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const client = new StubTelegramClient();
  const interpreter = new RecordingInterpreter();
  const interactions = new InteractionStore();
  const repos = new MockAccountRepositories(store);
  const audits: AuditEvent[] = [];
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions: new SessionStore(),
    drafts: new DraftEngine(),
    interactions,
    interpreter,
    repos,
    client,
    auditor: createAuditor((event) => {
      audits.push(event);
    }),
    ...(opts?.topics !== undefined ? { operatorTopics: opts.topics } : {}),
  });
  let counter = 47000;
  return {
    app,
    client,
    interpreter,
    interactions,
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

function pinMessage(updateId: number, actorId: number, text: string, threadId?: number): unknown {
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

function pinCallback(updateId: number, actorId: number, data: string, threadId?: number): unknown {
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

function lastOwnedInteractionId(world: PinWorld): string {
  const owned = world.client.lastButtons().find((button) => button.callback_data !== undefined);
  return owned?.callback_data?.split(':')[2] ?? '';
}

async function tapView(world: PinWorld, actorId: number, index: number): Promise<void> {
  const data = callbackDataFor(`view${index}` as CallbackAction, lastOwnedInteractionId(world));
  await world.post(pinCallback(world.nextUpdateId(), actorId, data));
}

async function tapButton(world: PinWorld, actorId: number, text: string): Promise<void> {
  const data = world.client.buttonData(text);
  expect(data).toBeDefined();
  await world.post(pinCallback(world.nextUpdateId(), actorId, data as string));
}

async function searchPhoneSelect(
  world: PinWorld,
  actorId: number,
  phone: string,
  name: string,
): Promise<void> {
  await world.post(pinMessage(world.nextUpdateId(), actorId, phone));
  const customers = await world.repos.searchCustomersByPhone(phone);
  if (customers.length > 1) {
    const index = customers.findIndex((customer) => customer.nombre === name);
    expect(index).toBeGreaterThanOrEqual(0);
    await tapView(world, actorId, index);
  } else {
    expect(customers[0]?.nombre).toBe(name);
  }
}

function pinOf(raw: string): string | undefined {
  const identities = identifyPhone(raw);
  const only = identities.length === 1 ? identities[0] : undefined;
  return only === undefined ? undefined : deriveNetflixProfilePin(only);
}

function netflixRow(overrides: Partial<MockAccount>): MockAccount {
  return {
    servicio: 'netflix',
    correo: 'pin-case@example.com',
    contrasena: 'pin-case-pwd',
    perfil: '1 PERFIL (9)',
    fechaInicio: null,
    fechaFin: '2026-11-11',
    dias: null,
    estatus: '',
    nombre: 'Pin Case',
    monto: null,
    estado: '',
    numero: '4145460657',
    pais: 'VE',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PIN derivation 1–5: central last-4 rule
// ---------------------------------------------------------------------------

describe('netflix PIN derivation (1–5)', () => {
  it('(1) `+58 414-5460657` derives `0657` (country irrelevant)', () => {
    expect(pinOf('+58 414-5460657')).toBe('0657');
  });

  it('(2) `+1 612 441 8159` derives `8159`', () => {
    expect(pinOf('+1 612 441 8159')).toBe('8159');
  });

  it('(3) trailing `0012` stays the 4-char STRING `"0012"`, never a number', () => {
    const pin = pinOf('+58 414-5400012');
    expect(pin).toBe('0012');
    expect(typeof pin).toBe('string');
  });

  it('(4) format invariance: national, trunk and international forms agree', () => {
    expect(pinOf('4145460657')).toBe('0657');
    expect(pinOf('0414-5460657')).toBe('0657');
    expect(pinOf('+58 414-5460657')).toBe('0657');
  });

  it('(5) derivation is central: bundle PIN equals the single-identity rule', async () => {
    const world = await createPinWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('gloria castañeda');
    const bundle = bundles[0]!;
    const expected = deriveNetflixProfilePin(singleUsableIdentity(bundle.customerPhones)!);
    expect(bundle.pin).toBe(expected);
    expect(bundle.pin).toBe('4828');
  });
});

// ---------------------------------------------------------------------------
// PIN bundle + card + template 6–10
// ---------------------------------------------------------------------------

describe('netflix PIN bundle, card and template (6–10)', () => {
  it('(6) bundle carries the PIN on Netflix, never on FlujoTV', async () => {
    const world = await createPinWorld();
    const gloria = await world.repos.getCredentialBundlesForCustomer('gloria castañeda');
    expect(gloria[0]?.pin).toBe('4828');
    const anny = await world.repos.getCredentialBundlesForCustomer('anny tovar');
    expect(anny[0]?.pin).toBeUndefined();
    expect(anny[0]?.service).toBe('flujotv');
  });

  it('(7) the Telegram Netflix datos card shows 🔒 PIN', async () => {
    const world = await createPinWorld();
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    await world.post(pinMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    expect(world.client.lastText()).toContain('🔒 PIN: 4828');
  });

  it('(8) normal Fase 2 search NEVER shows the PIN', async () => {
    const world = await createPinWorld();
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    await world.post(pinMessage(world.nextUpdateId(), GABRIEL, 'dasdsadasda@gmail.com'));
    for (const text of world.client.texts()) {
      // The PIN line never appears (raw phone digits may echo in cards —
      // only the derived `🔒 PIN:` line is forbidden here).
      expect(text).not.toContain('🔒 PIN');
      expect(text).not.toMatch(/PIN:/);
    }
  });

  it('(9) credentials.netflix ALWAYS includes the PIN (never PIN-less)', async () => {
    const world = await createPinWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('gloria castañeda');
    const text = renderCredentialWhatsAppText(bundles[0]!);
    expect(text).toContain('🔒 PIN: 4828');
  });

  it('(10) per-assignment correctness: Daniel 1745, Rafael 8159, Yuyu 9085, Gloria 4828', async () => {
    const world = await createPinWorld();
    await world.post(pinMessage(world.nextUpdateId(), GABRIEL, 'dasdsadasda@gmail.com'));
    await tapButton(world, GABRIEL, '🔐Datos');
    expect(world.client.lastText()).toContain('¿Qué datos necesitas? (4)');
    await tapView(world, GABRIEL, 0);
    expect(world.client.lastText()).toContain('🔒 PIN: 1745');
    expect(world.client.lastText()).toContain('Daniel pares');
    await tapButton(world, GABRIEL, '← Servicios');
    await tapView(world, GABRIEL, 3);
    expect(world.client.lastText()).toContain('🔒 PIN: 4828');
    expect(world.client.lastText()).toContain('Gloria Castañeda');
  });
});

// ---------------------------------------------------------------------------
// PIN scoping 11–17: non-arbitrary, secret-free, preserved, recomputed
// ---------------------------------------------------------------------------

describe('netflix PIN scoping (11–17)', () => {
  it('(11) multi-phone is never arbitrary: contextual match wins, else own, else ask', () => {
    // Contextual phone matching the assignment wins.
    expect(resolveNetflixPin(['4145460657'], '+58 414-5460657')).toBe('0657');
    // Contextual phone NOT belonging to the assignment never leaks in.
    expect(resolveNetflixPin(['4145460657'], '+1 612 441 8159')).toBe('0657');
    // Two usable assignment phones with no context → undefined (ask first).
    expect(resolveNetflixPin(['4145460657', '4243764828'])).toBeUndefined();
    // …unless the context names one of them unequivocally.
    expect(resolveNetflixPin(['4145460657', '4243764828'], '4243764828')).toBe('4828');
  });

  it('(12) synthetic same-account rows keep per-row PINs (no sibling bleed)', () => {
    const bundles = buildCredentialBundles(
      [
        netflixRow({ perfil: '1 PERFIL (1)', nombre: 'Pin Case', numero: '4145460657' }),
        netflixRow({ perfil: '1 PERFIL (2)', nombre: 'Pin Case', numero: '4243764828' }),
      ],
      [],
    );
    expect(bundles[0]?.pin).toBe('0657');
    expect(bundles[1]?.pin).toBe('4828');
  });

  it('(13) Gemini, logs and Alertas never carry the PIN', async () => {
    const world = await createPinWorld();
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    await world.post(pinMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await world.post(pinMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp'));
    const seen = world.interpreter.seenTexts.join('\n');
    expect(seen).not.toContain('4828');
    const audits = JSON.stringify(world.audits);
    expect(audits).not.toContain('4828');
    expect(audits).not.toContain('🔒 PIN');
    for (const password of DENY_PASSWORDS) {
      expect(seen).not.toContain(password);
      expect(audits).not.toContain(password);
    }
  });

  it('(14) General and foreign topics never carry the PIN', async () => {
    const world = await createPinWorld({
      topics: new Map([
        [GABRIEL, T_GABRIEL],
        [EDWARD, 202],
      ]),
    });
    await world.post(pinMessage(world.nextUpdateId(), GABRIEL, 'dame los datos', T_GABRIEL));
    const guide = world.client.lastText();
    expect(guide).not.toContain('4828');
    expect(guide).not.toContain('🔒 PIN');
    for (const password of DENY_PASSWORDS) {
      expect(guide).not.toContain(password);
    }
    await world.post(pinMessage(world.nextUpdateId(), GABRIEL, 'dame los datos', 202));
    const mismatch = world.client.lastText();
    expect(mismatch).not.toContain('4828');
    expect(mismatch).not.toContain('🔒 PIN');
  });

  it('(15) single-card navigation preserves the PIN (selection is an edit)', async () => {
    const world = await createPinWorld();
    await world.post(pinMessage(world.nextUpdateId(), GABRIEL, 'dasdsadasda@gmail.com'));
    await tapButton(world, GABRIEL, '🔐Datos');
    await tapView(world, GABRIEL, 1);
    expect(world.client.lastKind()).toBe('edit');
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    expect(card).toContain('🔒 PIN: 8159');
    expect(card).toContain('Rafael minnesota');
  });

  it('(16) reassignment recomputes the PIN (Daniel 1745 → Gloria 4828)', async () => {
    const world = await createPinWorld();
    await world.post(pinMessage(world.nextUpdateId(), GABRIEL, 'dasdsadasda@gmail.com'));
    await tapButton(world, GABRIEL, '🔐Datos');
    await tapView(world, GABRIEL, 0);
    expect(world.client.lastText()).toContain('🔒 PIN: 1745');
    await tapButton(world, GABRIEL, '← Servicios');
    await tapView(world, GABRIEL, 3);
    const card = world.client.lastText();
    expect(card).toContain('🔒 PIN: 4828');
    expect(card).not.toContain('1745');
  });

  it('(17) no PIN persistence: interaction state keeps safe refs only', async () => {
    const world = await createPinWorld();
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    await world.post(pinMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    await world.post(pinMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp'));
    const blob = JSON.stringify(world.interactions.snapshot());
    // No secret values and no `pin` key anywhere in persisted state
    // (stored phone-query digits may echo — only secrets are forbidden).
    expect(blob).not.toContain('simara23075');
    expect(blob).not.toContain('"pin"');
    expect(blob).not.toContain('🔒 PIN');
  });
});

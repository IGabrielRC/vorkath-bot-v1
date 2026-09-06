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
import { accountPasswordFor, buildCredentialBundles } from '../src/mock/credentials';
import type { MockAccount } from '../src/mock/excelLoader';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';
import { callbackDataFor, type CallbackAction } from '../src/telegram/keyboards';
import { credentialOptionLabel, resolveCredentialView } from '../src/tools/credentials';

/**
 * Slice A — explicit credentials read (SHOW_CREDENTIALS).
 *
 * REAL fixture values throughout:
 * - Netflix `dasdsadasda@gmail.com` (pwd `simara23075`): Daniel pares /
 *   Rafael minnesota / Yuyu / Gloria Castañeda (`1 PERFIL (4)`).
 * - FlujoTV shared `cmaxnet001`: Anny Tovar (`ncsa909`) / Neisis Zambrano
 *   (`hjdksa989`) / Roman Morales (`asdd76`) — per-slot passwords.
 * - FlujoTV complete `maxnet001`: Jesus Galvis (`sasdas09`).
 * - Rafael minnesota (phone `16124418159`): 4 assignments (Netflix +
 *   FlujoTV shared ×2 + FlujoTV complete) — the ambiguous case.
 * - Phone `4143764828`: Gloria Castañeda + Franklin Castañeda.
 * The fixture carries NO PIN column, so PIN stays absent — never invented.
 */

const GABRIEL = 1057242322;
const EDWARD = 941030473;
const GROUP_CHAT_ID = -1005550001;
const T_GABRIEL = 101;
const T_EDWARD = 202;
const T_ALERTS = 303;

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

/** Passwords that must NEVER appear outside the explicit credential card. */
const DENY_PASSWORDS = [
  'simara23075',
  'ncsa909',
  'hjdksa989',
  'asdd76',
  'sasdas09',
  'loro5544',
  'juan8727',
  'hedare28202',
];

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

  lastText(): string {
    return this.texts()[this.texts().length - 1] ?? '';
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

/** Recording interpreter: captures every text that reaches Gemini. */
class RecordingInterpreter extends StubIntentInterpreter {
  readonly seenTexts: string[] = [];

  override async interpret(text: string, ctx: SessionCtx): Promise<Intent> {
    this.seenTexts.push(text);
    return super.interpret(text, ctx);
  }
}

interface CredWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: RecordingInterpreter;
  interactions: InteractionStore;
  repos: MockAccountRepositories;
  store: MockStore;
  audits: AuditEvent[];
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

async function createCredWorld(opts?: {
  topics?: Map<number, number>;
  alertsTopicId?: number;
}): Promise<CredWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-cred-'));
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
    ...(opts?.alertsTopicId !== undefined ? { alertsTopicId: opts.alertsTopicId } : {}),
  });
  let counter = 7000;
  return {
    app,
    client,
    interpreter,
    interactions,
    repos,
    store,
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

function credMessage(updateId: number, actorId: number, text: string, threadId?: number): unknown {
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

function credCallback(updateId: number, actorId: number, data: string, threadId?: number): unknown {
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

function lastInteractionId(world: CredWorld): string {
  const first = world.client.lastButtons()[0];
  return first?.callback_data.split(':')[2] ?? '';
}

/** Taps the `view{index}` button of the latest owned list. */
async function tapView(world: CredWorld, actorId: number, index: number, threadId?: number): Promise<void> {
  const data = callbackDataFor(`view${index}` as CallbackAction, lastInteractionId(world));
  await world.post(credCallback(world.nextUpdateId(), actorId, data, threadId));
}

/** Selects a customer out of a phone-search disambiguation list by name. */
async function selectCustomerByName(
  world: CredWorld,
  actorId: number,
  phone: string,
  name: string,
  threadId?: number,
): Promise<void> {
  const customers = await world.repos.searchCustomersByPhone(phone);
  const index = customers.findIndex((customer) => customer.nombre === name);
  expect(index).toBeGreaterThanOrEqual(0);
  await tapView(world, actorId, index, threadId);
}

/** Runs a phone search; taps through disambiguation only when needed. */
async function searchPhoneSelect(
  world: CredWorld,
  actorId: number,
  phone: string,
  name: string,
  threadId?: number,
): Promise<void> {
  await world.post(credMessage(world.nextUpdateId(), actorId, phone, threadId));
  const customers = await world.repos.searchCustomersByPhone(phone);
  if (customers.length > 1) {
    await selectCustomerByName(world, actorId, phone, name, threadId);
  } else {
    expect(customers[0]?.nombre).toBe(name);
  }
}

// ---------------------------------------------------------------------------
// Netflix credentials (1–8)
// ---------------------------------------------------------------------------

describe('slice A: Netflix credentials (1–8)', () => {
  it('(1) CredentialBundle carries ONLY real fields, Netflix account-scoped', async () => {
    const world = await createCredWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('gloria castañeda');
    expect(bundles).toHaveLength(1);
    const bundle = bundles[0]!;
    expect(bundle.service).toBe('netflix');
    expect(bundle.serviceLabel).toBe('Netflix');
    expect(bundle.accountIdentifier).toBe('dasdsadasda@gmail.com');
    expect(bundle.accountPassword).toBe('simara23075');
    expect(bundle.passwordScope).toBe('account');
    expect(bundle.profile).toBe('1 PERFIL (4)');
    expect(bundle.accountType).toBe('netflix-profile');
    expect(bundle.customerName).toBe('Gloria Castañeda');
    expect(bundle.pin).toBeUndefined();
  });

  it('(2) explicit datos request shows the account identifier', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    expect(world.client.lastText()).toContain('dasdsadasda@gmail.com');
  });

  it('(3) explicit datos request shows the real MOCK password', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    expect(card).toContain('simara23075');
    expect(card).toContain('Gloria Castañeda');
  });

  it('(4) the card shows the correct profile, never a sibling slot', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const card = world.client.lastText();
    expect(card).toContain('1 PERFIL (4)');
    expect(card).not.toContain('1 PERFIL (1)');
    expect(card).not.toContain('1 PERFIL (2)');
  });

  it('(5) PIN is absent when source carries no real PIN', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    expect(world.client.lastText()).not.toContain('PIN');
  });

  it('(6) Netflix password is tied to the account, not the profile', async () => {
    const world = await createCredWorld();
    const password = accountPasswordFor(world.store.accounts, {
      servicio: 'netflix',
      correo: 'dasdsadasda@gmail.com',
      contrasena: '',
      perfil: '1 PERFIL (9)',
      fechaInicio: null,
      fechaFin: null,
      dias: null,
      estatus: '',
      nombre: 'Probe',
      monto: null,
      estado: '',
      numero: '',
      pais: '',
    } as MockAccount);
    expect(password).toBe('simara23075');
    const rafael = await world.repos.getCredentialBundlesForCustomer('rafael minnesota');
    const netflix = rafael.find((bundle) => bundle.service === 'netflix');
    expect(netflix?.accountPassword).toBe('simara23075');
    const daniel = await world.repos.getCredentialBundlesForCustomer('daniel pares');
    expect(daniel[0]?.accountPassword).toBe('simara23075');
  });

  it('(7) plain search NEVER shows passwords or PIN', async () => {
    const world = await createCredWorld();
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dasdsadasda@gmail.com'));
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    for (const text of world.client.texts()) {
      for (const password of DENY_PASSWORDS) {
        expect(text).not.toContain(password);
      }
      expect(text).not.toContain('Contraseña');
      expect(text).not.toContain('PIN');
    }
  });

  it('(8) L2 explicit phrase renders direct with zero Gemini', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    const callsBefore = world.interpreter.calls;
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'pásame los datos'));
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    expect(card).toContain('simara23075');
    expect(world.interpreter.calls).toBe(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// FlujoTV credentials (9–14)
// ---------------------------------------------------------------------------

describe('slice A: FlujoTV credentials (9–14)', () => {
  it('(9) shared FlujoTV shows its own model: Usuario + Perfil + slot password', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    expect(card).toContain('FlujoTV');
    expect(card).toContain('cmaxnet001');
    expect(card).toContain('ncsa909');
    expect(card).toContain('Anny Tovar');
  });

  it('(10) shared slots keep per-slot passwords, never the Netflix shape', async () => {
    const world = await createCredWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('neisis zambrano');
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.accountPassword).toBe('hjdksa989');
    expect(bundles[0]?.accountPassword).not.toBe('ncsa909');
    expect(bundles[0]?.accountType).toBe('flujotv-shared');
    expect(bundles[0]?.passwordScope).toBe('slot');
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const card = world.client.lastText();
    expect(card).not.toContain('@');
    expect(card).toContain('Usuario');
  });

  it('(11) complete FlujoTV shows Usuario + Completa + its password', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '34674003172', 'Jesus Galvis');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    expect(card).toContain('maxnet001');
    expect(card).toContain('Completa');
    expect(card).toContain('asdd76');
  });

  it('(12) complete accounts never render a profile-number shape', async () => {
    const world = await createCredWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('jesus galvis');
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.accountType).toBe('flujotv-complete');
    await searchPhoneSelect(world, GABRIEL, '34674003172', 'Jesus Galvis');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    expect(world.client.lastText()).not.toContain('1 PERFIL');
  });

  it('(13) FlujoTV cards carry no Netflix shape', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '34674003172', 'Jesus Galvis');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const card = world.client.lastText();
    expect(card).toContain('Usuario: maxnet001');
    expect(card).not.toContain('Cuenta: dasdsadasda@gmail.com');
  });

  it('(14) 🔐Datos button and NL phrase run the SAME tool (identical card)', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const nlCard = world.client.lastText();
    const datosCallback = world.client.findButton('🔐Datos');
    expect(datosCallback).toBeDefined();
    await world.post(credCallback(world.nextUpdateId(), GABRIEL, datosCallback!));
    expect(world.client.lastText()).toBe(nlCard);
  });
});

// ---------------------------------------------------------------------------
// Credential context (15–19)
// ---------------------------------------------------------------------------

describe('slice A: credential context (15–19)', () => {
  it('(15) customer selection is reused; ambiguity asks with real options only', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const ask = world.client.lastText();
    expect(ask).toContain('¿Qué datos necesitas?');
    expect(ask).not.toContain('simara23075');
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons.some((text) => text.includes('Netflix'))).toBe(true);
    expect(buttons.some((text) => text.includes('FlujoTV'))).toBe(true);
    const netflixIndex = buttons.findIndex((text) => text.includes('Netflix'));
    await tapView(world, GABRIEL, netflixIndex);
    const card = world.client.lastText();
    expect(card).toContain('simara23075');
    expect(card).toContain('1 PERFIL (1)');
    expect(card).toContain('Rafael minnesota');
  });

  it('(16) L3 reference variant resolves the own account selection (Gemini invoked)', async () => {
    const world = await createCredWorld();
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    const callsBefore = world.interpreter.calls;
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, '¿qué clave tiene esa cuenta?'));
    expect(world.interpreter.calls).toBe(callsBefore + 1);
    const ask = world.client.lastText();
    expect(ask).toContain('¿Qué datos necesitas?');
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons.some((text) => text.includes('Anny Tovar'))).toBe(true);
    expect(buttons.some((text) => text.includes('Neisis Zambrano'))).toBe(true);
    expect(buttons.some((text) => text.includes('Roman Morales'))).toBe(true);
    for (const password of DENY_PASSWORDS) {
      expect(ask).not.toContain(password);
    }
  });

  it('(17) cross-actor reference never leaks: Gabriel ≠ Edward', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    await world.post(credMessage(world.nextUpdateId(), EDWARD, 'dame los datos'));
    const reply = world.client.lastText();
    expect(reply).not.toContain('simara23075');
    expect(reply).toContain('Primero busca');
  });

  it('(18) ambiguous context asks ONLY the missing choice, then renders', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame usuario y contraseña'));
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons).toHaveLength(5);
    const ask = world.client.lastText();
    for (const password of DENY_PASSWORDS) {
      expect(ask).not.toContain(password);
    }
  });

  it('(19) "dame los datos de Netflix" with one Netflix assignment goes direct', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '16124418159', 'Rafael minnesota');
    const callsBefore = world.interpreter.calls;
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos de Netflix'));
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    expect(card).toContain('Netflix');
    expect(card).toContain('simara23075');
    expect(world.interpreter.calls).toBe(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// Slice-A security (46–50)
// ---------------------------------------------------------------------------

describe('slice A: credential security (46–50)', () => {
  it('(46) Gemini NEVER receives credentials', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    expect(world.client.lastText()).toContain('simara23075');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, '¿qué clave tiene esa cuenta?'));
    expect(world.interpreter.seenTexts.length).toBeGreaterThan(0);
    for (const seen of world.interpreter.seenTexts) {
      for (const password of DENY_PASSWORDS) {
        expect(seen).not.toContain(password);
      }
    }
  });

  it('(47) audit carries safe refs only — never secrets', async () => {
    const world = await createCredWorld();
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const views = world.audits.filter((event) => event.actionType === 'credential.viewed');
    expect(views).toHaveLength(1);
    expect(views[0]?.metadata?.['service']).toBe('netflix');
    expect(views[0]?.metadata?.['accountRef']).toBe('dasdsadasda@gmail.com');
    expect(views[0]?.metadata?.['customerRef']).toBe('Gloria Castañeda');
    for (const event of world.audits) {
      const serialized = JSON.stringify(event);
      for (const password of DENY_PASSWORDS) {
        expect(serialized).not.toContain(password);
      }
    }
  });

  it('(48) normal customer and account cards stay secret-free', async () => {
    const world = await createCredWorld();
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    for (const text of world.client.texts()) {
      for (const password of DENY_PASSWORDS) {
        expect(text).not.toContain(password);
      }
      expect(text).not.toContain('🔐 DATOS DE ACCESO');
    }
  });

  it('(49) foreign-topic credential request is blocked with zero secrets', async () => {
    const world = await createCredWorld({
      topics: new Map([
        [GABRIEL, T_GABRIEL],
        [EDWARD, T_EDWARD],
      ]),
      alertsTopicId: T_ALERTS,
    });
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda', T_GABRIEL);
    await world.post(credMessage(world.nextUpdateId(), EDWARD, 'hola', T_EDWARD));
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos', T_EDWARD));
    const reply = world.client.lastText();
    expect(reply).toContain('Edward');
    for (const password of DENY_PASSWORDS) {
      expect(reply).not.toContain(password);
    }
  });

  it('(50) General and Alertas never render the sensitive card', async () => {
    const world = await createCredWorld({
      topics: new Map([
        [GABRIEL, T_GABRIEL],
        [EDWARD, T_EDWARD],
      ]),
      alertsTopicId: T_ALERTS,
    });
    await searchPhoneSelect(world, GABRIEL, '4243764828', 'Gloria Castañeda', T_GABRIEL);
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
    const generalReply = world.client.lastText();
    expect(generalReply).toContain('Gabriel');
    expect(generalReply).toContain('topic');
    await world.post(credMessage(world.nextUpdateId(), GABRIEL, 'dame los datos', T_ALERTS));
    const alertsReply = world.client.lastText();
    expect(alertsReply.toLowerCase()).toContain('alerta');
    for (const password of DENY_PASSWORDS) {
      expect(generalReply).not.toContain(password);
      expect(alertsReply).not.toContain(password);
    }
    expect(generalReply).not.toContain('🔐 DATOS DE ACCESO');
    expect(alertsReply).not.toContain('🔐 DATOS DE ACCESO');
  });
});

// ---------------------------------------------------------------------------
// Deterministic resolver unit (SHOW_CREDENTIALS tool contract)
// ---------------------------------------------------------------------------

describe('slice A: resolveCredentialView tool contract', () => {
  it('direct on one bundle, ask on many, none on empty, service filter narrows', async () => {
    const world = await createCredWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('rafael minnesota');
    expect(bundles.length).toBeGreaterThan(1);
    const direct = resolveCredentialView(bundles, 'netflix');
    expect(direct.kind).toBe('direct');
    if (direct.kind === 'direct') {
      expect(direct.bundle.service).toBe('netflix');
    }
    const ask = resolveCredentialView(bundles);
    expect(ask.kind).toBe('ask');
    expect(resolveCredentialView([]).kind).toBe('none');
  });

  it('option labels come from real data, client-prefixed only when shared', async () => {
    const world = await createCredWorld();
    const scoped = world.store.accounts.filter(
      (row) => row.nombre.trim().toLowerCase() === 'rafael minnesota',
    );
    const bundles = buildCredentialBundles(scoped, world.store.accounts);
    const single = credentialOptionLabel(bundles[0]!, false);
    expect(single).toContain('FlujoTV');
    const multi = credentialOptionLabel(bundles[0]!, true);
    expect(multi).toContain('Rafael minnesota');
  });
});

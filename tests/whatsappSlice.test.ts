import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi, type Mock } from 'vitest';
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
import { parseFast } from '../src/parser/fast';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';
import { callbackDataFor, type CallbackAction } from '../src/telegram/keyboards';
import { logger } from '../src/utils/logger';
import type { CredentialBundle } from '../src/mock/credentials';
import { usableIdentity, buildWhatsAppUrl, resolveWhatsAppTarget } from '../src/whatsapp/link';
import {
  defaultWhatsAppTemplates,
  renderCredentialWhatsAppText,
  selectWhatsAppTemplate,
  type WhatsAppTemplateId,
} from '../src/whatsapp/templates';

vi.mock('../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * Slice B — direct WhatsApp link (wa.me, prefilled, manual send).
 *
 * REAL fixture values throughout:
 * - Anny Tovar (`4145460657` → `584145460657`): 1 FlujoTV shared bundle
 *   (`cmaxnet001` / `ncsa909`) — the single-phone direct case.
 * - Andrés pereira (`34611161181 / 34641375927`, ES): 1 FlujoTV complete
 *   bundle (`maxnet003`) with TWO usable phones — the ask case.
 * - Rafael minnesota (`16124418159`, US): 4 bundles — the service-filter
 *   case (`dame los datos de Netflix por WhatsApp`).
 * - Netflix `dasdsadasda@gmail.com` (pwd `simara23075`).
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

/** Passwords that must NEVER reach Gemini, logs, audits or AlertService. */
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

  async sendMessage(opts: {
    chatId: number;
    text: string;
    replyMarkup?: unknown;
    messageThreadId?: number;
  }): Promise<unknown> {
    this.sent.push({ kind: 'send', payload: opts });
    return { ok: true };
  }

  async editMessageText(opts: {
    chatId: number;
    messageId: number;
    text: string;
    replyMarkup?: unknown;
    messageThreadId?: number;
  }): Promise<unknown> {
    this.sent.push({ kind: 'edit', payload: opts });
    return { ok: true };
  }

  async answerCallbackQuery(callbackQueryId: string, opts?: { text?: string }): Promise<unknown> {
    this.sent.push({ kind: 'answer', payload: { callbackQueryId, ...opts } });
    return { ok: true };
  }

  sendCount(): number {
    return this.sent.filter((entry) => entry.kind === 'send' || entry.kind === 'edit').length;
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

  lastUrlButton(): string | undefined {
    return this.lastButtons().find((button) => button.text === '💬 Abrir WhatsApp')?.url;
  }

  answers(): Array<{ callbackQueryId: string; text?: string }> {
    return this.sent
      .filter((entry) => entry.kind === 'answer')
      .map((entry) => entry.payload as { callbackQueryId: string; text?: string });
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

interface WaWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: RecordingInterpreter;
  interactions: InteractionStore;
  drafts: DraftEngine;
  repos: MockAccountRepositories;
  store: MockStore;
  audits: AuditEvent[];
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

async function createWaWorld(opts?: {
  topics?: Map<number, number>;
  alertsTopicId?: number;
}): Promise<WaWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-wa-'));
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
    ...(opts?.alertsTopicId !== undefined ? { alertsTopicId: opts.alertsTopicId } : {}),
  });
  let counter = 9000;
  return {
    app,
    client,
    interpreter,
    interactions,
    drafts,
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

function waMessage(updateId: number, actorId: number, text: string, threadId?: number): unknown {
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

function waCallback(updateId: number, actorId: number, data: string, threadId?: number): unknown {
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

function lastOwnedInteractionId(world: WaWorld): string {
  const owned = world.client.lastButtons().find((button) => button.callback_data !== undefined);
  return owned?.callback_data?.split(':')[2] ?? '';
}

/** Taps the `view{index}` button of the latest owned list. */
async function tapView(world: WaWorld, actorId: number, index: number, threadId?: number): Promise<void> {
  const data = callbackDataFor(`view${index}` as CallbackAction, lastOwnedInteractionId(world));
  await world.post(waCallback(world.nextUpdateId(), actorId, data, threadId));
}

/** Runs a phone search; taps through disambiguation only when needed. */
async function searchPhoneSelect(
  world: WaWorld,
  actorId: number,
  phone: string,
  name: string,
  threadId?: number,
): Promise<void> {
  await world.post(waMessage(world.nextUpdateId(), actorId, phone, threadId));
  const customers = await world.repos.searchCustomersByPhone(phone);
  if (customers.length > 1) {
    const index = customers.findIndex((customer) => customer.nombre === name);
    expect(index).toBeGreaterThanOrEqual(0);
    await tapView(world, actorId, index, threadId);
  } else {
    expect(customers[0]?.nombre).toBe(name);
  }
}

/** The Andrés ask setup: account search (no phone context) + WhatsApp request. */
async function setupAndresAsk(world: WaWorld, phrase = 'prepárame el mensaje'): Promise<void> {
  await world.post(waMessage(world.nextUpdateId(), GABRIEL, 'maxnet003'));
  expect(world.client.lastText()).toContain('maxnet003');
  await world.post(waMessage(world.nextUpdateId(), GABRIEL, phrase));
}

function loggedBlobs(): string[] {
  const calls: unknown[][] = [
    ...((logger.info as unknown as Mock).mock.calls as unknown[][]),
    ...((logger.warn as unknown as Mock).mock.calls as unknown[][]),
    ...((logger.error as unknown as Mock).mock.calls as unknown[][]),
  ];
  return calls.map((call) => JSON.stringify(call));
}

// ---------------------------------------------------------------------------
// Phone resolution (20–28)
// ---------------------------------------------------------------------------

describe('slice B: phone resolution (20–28)', () => {
  it('(20) explicit +CC forms (+1/+57/+34) become bare E.164 digits', () => {
    expect(usableIdentity('+18174487435')?.e164).toBe('18174487435');
    expect(usableIdentity('+57 300 123 4567')?.e164).toBe('573001234567');
    expect(usableIdentity('+34 674 003 172')?.e164).toBe('34674003172');
    for (const raw of ['+18174487435', '+57 300 123 4567', '+34 674 003 172']) {
      const url = buildWhatsAppUrl(usableIdentity(raw)!, 'hola');
      expect(url).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
      expect(url).not.toContain('+');
    }
  });

  it('(21) spaces, dashes and parens never reach the wa.me path', () => {
    const identity = usableIdentity('+58 424-3764828');
    expect(identity?.e164).toBe('584243764828');
    const url = buildWhatsAppUrl(identity!, 'hola');
    expect(url.startsWith('https://wa.me/584243764828?text=')).toBe(true);
    const legacy = usableIdentity('(0424) 376-4828');
    expect(legacy?.e164).toBe('584243764828');
    expect(buildWhatsAppUrl(legacy!, 'hola')).toBe(url);
  });

  it('(22) national-only never preferred over E.164', () => {
    // `44203222112` (UK-shaped, no plus) is unresolvable — never a link.
    expect(usableIdentity('44203222112')).toBeUndefined();
    const target = resolveWhatsAppTarget(['44203222112', '4145460657']);
    expect(target.kind).toBe('direct');
    if (target.kind === 'direct') {
      expect(target.identity.e164).toBe('584145460657');
    }
    // An unresolvable preferred (search-context) raw never wins either.
    const fallback = resolveWhatsAppTarget(['4145460657'], '44203222112');
    expect(fallback.kind).toBe('direct');
    if (fallback.kind === 'direct') {
      expect(fallback.identity.e164).toBe('584145460657');
    }
  });

  it('(23) legacy VE national resolves to a single safe E.164', () => {
    expect(usableIdentity('4145460657')?.e164).toBe('584145460657');
    expect(usableIdentity('04244145465')?.e164).toBe('584244145465');
    expect(usableIdentity('584145460657')?.e164).toBe('584145460657');
  });

  it('(24) unresolvable legacy yields NO link and builders fail closed', () => {
    expect(usableIdentity('5511987654321')).toBeUndefined();
    const target = resolveWhatsAppTarget(['5511987654321']);
    expect(target.kind).toBe('none');
    expect(() =>
      buildWhatsAppUrl({ raw: '5511987654321', normalizedDigits: '5511987654321' }, 'hola'),
    ).toThrow();
  });

  it('(25) explicit +CC wins over the legacy default region', () => {
    const identity = usableIdentity('+18174487435');
    expect(identity).toMatchObject({
      e164: '18174487435',
      countryCallingCode: '1',
      region: 'US',
    });
  });

  it('(26) the wa.me path carries digits only', () => {
    for (const raw of ['+58 424-3764828', '(0424) 376-4828', '+18174487435', '4145460657']) {
      const url = buildWhatsAppUrl(usableIdentity(raw)!, 'ping');
      const path = new URL(url).pathname.replace(/^\//, '');
      expect(path).toMatch(/^\d+$/);
    }
  });

  it('(27) a single usable number goes direct', () => {
    const target = resolveWhatsAppTarget(['4145460657']);
    expect(target.kind).toBe('direct');
    if (target.kind === 'direct') {
      expect(buildWhatsAppUrl(target.identity, 'hola')).toContain('wa.me/584145460657');
    }
  });

  it('(28) a valid search-context phone is preferred; an invalid one falls back', () => {
    const preferred = resolveWhatsAppTarget(['4242039835', '4124086018'], '4124086018');
    expect(preferred.kind).toBe('direct');
    if (preferred.kind === 'direct') {
      expect(preferred.identity.e164).toBe('584124086018');
    }
    const fallback = resolveWhatsAppTarget(['4242039835', '4124086018'], 'no-un-numero');
    expect(fallback.kind).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// Multiphone flow (29–32)
// ---------------------------------------------------------------------------

describe('slice B: multiphone flow (29–32)', () => {
  it('(29) single usable phone goes direct with zero Gemini', async () => {
    const world = await createWaWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    const callsBefore = world.interpreter.calls;
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp'));
    expect(world.interpreter.calls).toBe(callsBefore);
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    expect(card).toContain('ncsa909');
    expect(card).toContain('WhatsApp preparado');
    const url = world.client.lastUrlButton();
    expect(url?.startsWith('https://wa.me/584145460657?text=')).toBe(true);
    expect(world.drafts.snapshot()).toHaveLength(0);
  });

  it('(30) several usable phones with none selected ask exactly once', async () => {
    const world = await createWaWorld();
    await setupAndresAsk(world);
    const ask = world.client.lastText();
    expect(ask).toContain('¿A cuál número quieres enviar los datos?');
    expect(ask).not.toContain('🔐 DATOS DE ACCESO');
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons.some((text) => text.includes('34611161181'))).toBe(true);
    expect(buttons.some((text) => text.includes('34641375927'))).toBe(true);
    for (const password of DENY_PASSWORDS) {
      expect(ask).not.toContain(password);
    }
  });

  it('(31) a valid search-context phone is preferred over the ask', async () => {
    const world = await createWaWorld();
    await searchPhoneSelect(world, GABRIEL, '34611161181', 'Andrés pereira');
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, 'mándame el WhatsApp'));
    const card = world.client.lastText();
    expect(card).toContain('WhatsApp preparado');
    expect(card).not.toContain('¿A cuál número quieres enviar los datos?');
    expect(world.client.lastUrlButton()).toContain('wa.me/34611161181');
  });

  it('(32) phone tap links the chosen number; peer taps are rejected', async () => {
    const world = await createWaWorld();
    await setupAndresAsk(world);
    await tapView(world, GABRIEL, 1);
    const card = world.client.lastText();
    expect(card).toContain('🔐 DATOS DE ACCESO');
    expect(card).toContain('WhatsApp preparado');
    expect(world.client.lastUrlButton()).toContain('wa.me/34641375927');

    const cross = await createWaWorld();
    await setupAndresAsk(cross);
    const sendsBefore = cross.client.sendCount();
    const data = callbackDataFor('view0' as CallbackAction, lastOwnedInteractionId(cross));
    await cross.post(waCallback(cross.nextUpdateId(), EDWARD, data));
    expect(cross.client.sendCount()).toBe(sendsBefore);
    const toast = cross.client.answers()[cross.client.answers().length - 1]?.text ?? '';
    expect(toast).toContain('pertenece');
    expect(cross.client.lastUrlButton()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Templates (33–38)
// ---------------------------------------------------------------------------

describe('slice B: WhatsApp templates (33–38)', () => {
  it('(33) Netflix selects credentials.netflix with live bundle data', async () => {
    const world = await createWaWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('gloria castañeda');
    expect(bundles).toHaveLength(1);
    const bundle = bundles[0]!;
    expect(selectWhatsAppTemplate(bundle)).toBe('credentials.netflix');
    const text = renderCredentialWhatsAppText(bundle);
    expect(text).toContain('Gloria Castañeda');
    expect(text).toContain('Netflix');
    expect(text).toContain('dasdsadasda@gmail.com');
    expect(text).toContain('simara23075');
    expect(text).toContain('1 PERFIL (4)');
  });

  it('(34) FlujoTV shared selects its own template with the slot password', async () => {
    const world = await createWaWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('neisis zambrano');
    expect(bundles).toHaveLength(1);
    const bundle = bundles[0]!;
    expect(selectWhatsAppTemplate(bundle)).toBe('credentials.flujotv.shared');
    const text = renderCredentialWhatsAppText(bundle);
    expect(text).toContain('cmaxnet001');
    expect(text).toContain('hjdksa989');
    expect(text).not.toContain('ncsa909');
    expect(text).not.toContain('@');
  });

  it('(35) FlujoTV complete selects credentials.flujotv.complete', async () => {
    const world = await createWaWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('jesus galvis');
    expect(bundles).toHaveLength(1);
    const bundle = bundles[0]!;
    expect(selectWhatsAppTemplate(bundle)).toBe('credentials.flujotv.complete');
    const text = renderCredentialWhatsAppText(bundle);
    expect(text).toContain('maxnet001');
    expect(text).toContain('asdd76');
    expect(text).not.toContain('1 PERFIL');
  });

  it('(36) copy swaps WITHOUT touching the tool path', async () => {
    const world = await createWaWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('gloria castañeda');
    const bundle = bundles[0]!;
    const swapped: Record<WhatsAppTemplateId, (bundle: CredentialBundle) => string> = {
      'credentials.netflix': (entry) => `DATOS ${entry.customerName} ${entry.accountPassword}`,
      'credentials.flujotv.shared': defaultWhatsAppTemplates['credentials.flujotv.shared'],
      'credentials.flujotv.complete': defaultWhatsAppTemplates['credentials.flujotv.complete'],
    };
    // Same selection, same tool path — only the copy changed.
    expect(selectWhatsAppTemplate(bundle)).toBe('credentials.netflix');
    const before = renderCredentialWhatsAppText(bundle);
    const after = renderCredentialWhatsAppText(bundle, swapped);
    expect(after).not.toBe(before);
    expect(after).toContain('simara23075');
    expect(after).not.toContain('¡Hola');
  });

  it('(37) templates invent nothing: no PIN line without a real PIN', async () => {
    const world = await createWaWorld();
    const bundles = await world.repos.getCredentialBundlesForCustomer('anny tovar');
    const text = renderCredentialWhatsAppText(bundles[0]!);
    expect(text).not.toContain('PIN');
    expect(text).toContain('Anny Tovar');
  });

  it('(38) button≡NL same tool: L2 phrases share the path, L3 covers semantics', async () => {
    expect(parseFast('abre WhatsApp')).toMatchObject({ kind: 'whatsapp' });
    expect(parseFast('mándame el WhatsApp')).toMatchObject({ kind: 'whatsapp' });
    expect(parseFast('prepárame el mensaje')).toMatchObject({ kind: 'whatsapp' });
    expect(parseFast('dame los datos de Netflix por WhatsApp')).toMatchObject({
      kind: 'whatsapp',
      service: 'netflix',
    });

    const world = await createWaWorld();
    const semantic = await world.interpreter.interpret('esa cuenta, pásame la clave por el whatsapp', {
      userId: GABRIEL,
    });
    expect(semantic.name).toBe('OPEN_CREDENTIALS');
    expect(semantic.params['whatsapp']).toBe(true);

    const first = await createWaWorld();
    await searchPhoneSelect(first, GABRIEL, '4145460657', 'Anny Tovar');
    await first.post(waMessage(first.nextUpdateId(), GABRIEL, 'abre WhatsApp'));
    const viaButtonTwin = first.client.lastText();

    const second = await createWaWorld();
    await searchPhoneSelect(second, GABRIEL, '4145460657', 'Anny Tovar');
    const callsBefore = second.interpreter.calls;
    await second.post(waMessage(second.nextUpdateId(), GABRIEL, 'prepárame el mensaje'));
    expect(second.interpreter.calls).toBe(callsBefore);
    expect(second.client.lastText()).toBe(viaButtonTwin);

    // Service filter narrows to the single Netflix assignment (Rafael).
    const filtered = await createWaWorld();
    await searchPhoneSelect(filtered, GABRIEL, '16124418159', 'Rafael minnesota');
    await filtered.post(waMessage(filtered.nextUpdateId(), GABRIEL, 'dame los datos de Netflix por WhatsApp'));
    const card = filtered.client.lastText();
    expect(card).toContain('Netflix');
    expect(card).toContain('simara23075');
    expect(card).toContain('WhatsApp preparado');
    expect(filtered.client.lastUrlButton()).toContain('wa.me/16124418159');
  });
});

// ---------------------------------------------------------------------------
// Encoding (39–45)
// ---------------------------------------------------------------------------

describe('slice B: wa.me encoding (39–45)', () => {
  const identity = usableIdentity('+584145460657')!;

  function roundTrip(text: string): string {
    const url = buildWhatsAppUrl(identity, text);
    return new URL(url).searchParams.get('text') ?? '';
  }

  it('(39) spaces are encoded and round-trip', () => {
    const text = 'Hola Anny Tovar datos de acceso';
    const url = buildWhatsAppUrl(identity, text);
    expect(url).not.toContain(' ');
    expect(roundTrip(text)).toBe(text);
  });

  it('(40) line breaks are encoded and round-trip', () => {
    const text = '¡Hola!\nCuenta: cmaxnet001\nContraseña: ncsa909';
    expect(buildWhatsAppUrl(identity, text)).toContain('%0A');
    expect(roundTrip(text)).toBe(text);
  });

  it('(41) emoji round-trips', () => {
    const text = '¡Hola! 👋🍿 ✅';
    const url = buildWhatsAppUrl(identity, text);
    expect(url).not.toContain('👋');
    expect(roundTrip(text)).toBe(text);
  });

  it('(42) ñ and accents round-trip', () => {
    const text = 'Contraseña del niño: hjdksa989 — camión';
    expect(roundTrip(text)).toBe(text);
    expect(buildWhatsAppUrl(identity, 'ñ')).not.toContain('ñ');
  });

  it('(43) & never splits the query', () => {
    const text = 'Usuario: maxnet001 & clave: asdd76';
    expect(buildWhatsAppUrl(identity, text)).toContain('%26');
    expect(roundTrip(text)).toBe(text);
  });

  it('(44) ? never starts a new query string', () => {
    const text = '¿qué clave tiene esa cuenta?';
    expect(buildWhatsAppUrl(identity, text)).toContain('%3F');
    expect(roundTrip(text)).toBe(text);
  });

  it('(45) # never starts a fragment', () => {
    const text = 'cuenta #4: maxnet001';
    const url = buildWhatsAppUrl(identity, text);
    expect(url).toContain('%23');
    expect(new URL(url).hash).toBe('');
    expect(roundTrip(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Slice-B security (46–51 subset)
// ---------------------------------------------------------------------------

describe('slice B: delivery security (46–51)', () => {
  it('(46B) Gemini NEVER sees credentials or wa.me URLs', async () => {
    const world = await createWaWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp'));
    expect(world.client.lastUrlButton()).toContain('wa.me/');
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, '¿qué clave tiene esa cuenta?'));
    expect(world.interpreter.seenTexts.length).toBeGreaterThan(0);
    for (const seen of world.interpreter.seenTexts) {
      for (const password of DENY_PASSWORDS) {
        expect(seen).not.toContain(password);
      }
      expect(seen).not.toContain('wa.me');
    }
  });

  it('(47B) audit and logs carry safe refs only — never secrets or URLs', async () => {
    const world = await createWaWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp'));
    const prepared = world.audits.filter((event) => event.actionType === 'whatsapp.link_prepared');
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.metadata?.['service']).toBe('flujotv');
    expect(prepared[0]?.metadata?.['accountRef']).toBe('cmaxnet001');
    expect(prepared[0]?.metadata?.['customerRef']).toBe('Anny Tovar');
    for (const event of world.audits) {
      const serialized = JSON.stringify(event);
      for (const password of DENY_PASSWORDS) {
        expect(serialized).not.toContain(password);
      }
      expect(serialized).not.toContain('wa.me');
    }
    for (const blob of loggedBlobs()) {
      for (const password of DENY_PASSWORDS) {
        expect(blob).not.toContain(password);
      }
      expect(blob).not.toContain('wa.me');
    }
  });

  it('(48B) AlertService stays silent: client name only, no alert thread post', async () => {
    const world = await createWaWorld({
      topics: new Map([
        [GABRIEL, T_GABRIEL],
        [EDWARD, T_EDWARD],
      ]),
      alertsTopicId: T_ALERTS,
    });
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar', T_GABRIEL);
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp', T_GABRIEL));
    expect(world.client.lastUrlButton()).toContain('wa.me/');
    const alertPosts = world.client
      .messages()
      .filter((message) => message.messageThreadId === T_ALERTS);
    expect(alertPosts).toHaveLength(0);
  });

  it('(49B) normal search stays credential-free after a delivery', async () => {
    const world = await createWaWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp'));
    const before = world.client.texts().length;
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    for (const text of world.client.texts().slice(before)) {
      for (const password of DENY_PASSWORDS) {
        expect(text).not.toContain(password);
      }
      expect(text).not.toContain('wa.me');
    }
  });

  it('(50B) foreign-topic delivery request is blocked with zero secrets', async () => {
    const world = await createWaWorld({
      topics: new Map([
        [GABRIEL, T_GABRIEL],
        [EDWARD, T_EDWARD],
      ]),
      alertsTopicId: T_ALERTS,
    });
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar', T_GABRIEL);
    await world.post(waMessage(world.nextUpdateId(), EDWARD, 'hola', T_EDWARD));
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp', T_EDWARD));
    const reply = world.client.lastText();
    expect(reply).toContain('Edward');
    expect(world.client.lastUrlButton()).toBeUndefined();
    for (const password of DENY_PASSWORDS) {
      expect(reply).not.toContain(password);
    }
    expect(reply).not.toContain('wa.me');
  });

  it('(51B) General and Alertas never prepare a link', async () => {
    const world = await createWaWorld({
      topics: new Map([
        [GABRIEL, T_GABRIEL],
        [EDWARD, T_EDWARD],
      ]),
      alertsTopicId: T_ALERTS,
    });
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar', T_GABRIEL);
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp'));
    const generalReply = world.client.lastText();
    expect(generalReply).toContain('Gabriel');
    expect(generalReply).not.toContain('🔐 DATOS DE ACCESO');
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp', T_ALERTS));
    const alertsReply = world.client.lastText();
    expect(alertsReply.toLowerCase()).toContain('alerta');
    expect(alertsReply).not.toContain('🔐 DATOS DE ACCESO');
    expect(world.client.lastUrlButton()).toBeUndefined();
    for (const password of DENY_PASSWORDS) {
      expect(generalReply).not.toContain(password);
      expect(alertsReply).not.toContain(password);
    }
  });
});

// ---------------------------------------------------------------------------
// Send semantics (56–59)
// ---------------------------------------------------------------------------

describe('slice B: send semantics (56–59)', () => {
  it('(56) the link is generated prefilled and drafts stay untouched', async () => {
    const world = await createWaWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp'));
    const url = world.client.lastUrlButton();
    expect(url?.startsWith('https://wa.me/584145460657?text=')).toBe(true);
    const prefilled = new URL(url!).searchParams.get('text') ?? '';
    expect(prefilled).toContain('ncsa909');
    expect(prefilled).toContain('Anny Tovar');
    expect(world.drafts.snapshot()).toHaveLength(0);
  });

  it('(57) no SENT state exists anywhere in the flow', async () => {
    const world = await createWaWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp'));
    for (const interaction of world.interactions.snapshot()) {
      expect(JSON.stringify(interaction.state)).not.toContain('SENT');
      expect(interaction.status).not.toBe('SENT');
    }
    for (const text of world.client.texts()) {
      expect(text).not.toContain('SENT');
    }
    for (const event of world.audits) {
      expect(event.actionType).not.toMatch(/sent|enviad/i);
    }
  });

  it('(58) the word "enviado" appears nowhere in src', () => {
    const roots = [resolve(process.cwd(), 'src')];
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (full.endsWith('.ts')) {
          files.push(full);
        }
      }
    };
    for (const root of roots) {
      walk(root);
    }
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/enviado/i);
    }
  });

  it('(59) the UI says preparado — sending is never claimed', async () => {
    const world = await createWaWorld();
    await searchPhoneSelect(world, GABRIEL, '4145460657', 'Anny Tovar');
    await world.post(waMessage(world.nextUpdateId(), GABRIEL, 'abre WhatsApp'));
    const card = world.client.lastText();
    expect(card).toContain('💬 WhatsApp preparado.');
    const buttons = world.client.lastButtons().map((button) => button.text);
    expect(buttons).toContain('💬 Abrir WhatsApp');
    expect(buttons).toContain('←Volver');
    for (const text of world.client.texts()) {
      expect(text.toLowerCase()).not.toContain('enviad');
    }
    const linkAudits = world.audits.filter((event) => event.actionType.startsWith('whatsapp.'));
    expect(linkAudits.map((event) => event.actionType)).toEqual(['whatsapp.link_prepared']);
  });
});

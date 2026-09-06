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
  deriveExpiryStatus,
  formatCustomerCard,
  groupRowsIntoCustomers,
  type Customer,
} from '../src/mock/customers';
import type { MockAccount } from '../src/mock/excelLoader';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import {
  identitiesMatch,
  identifyPhone,
  normalizePhoneKeys,
} from '../src/mock/phone';
import { extractPhoneCandidates, parsePhone } from '../src/parser/fast';
import { SessionStore } from '../src/session/store';
import { callbackDataFor } from '../src/telegram/keyboards';
import type { TelegramClient } from '../src/telegram/client';

const GABRIEL = 1057242322;
const EDWARD = 941030473;
const GROUP_CHAT_ID = -1005550001;

const NAMES: Record<number, string> = { [GABRIEL]: 'Gabriel', [EDWARD]: 'Edward' };

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

function row(nombre: string, numero: string): MockAccount {
  return {
    servicio: 'flujotv',
    correo: '',
    contrasena: '',
    perfil: 'perfil-1',
    fechaInicio: null,
    fechaFin: '2026-09-07',
    dias: null,
    estatus: 'VIGENTE',
    nombre,
    monto: null,
    estado: '',
    numero,
    pais: 'VE',
  };
}

// ---------------------------------------------------------------------------
// Normalizer matrix (PhoneIdentity + keys)
// ---------------------------------------------------------------------------

describe('slice A: PhoneIdentity normalizer matrix', () => {
  it('VE variants (bare/trunk/spaced/dashed/+58) share one identity', () => {
    const variants = ['4145460657', '04145460657', '0414 546 0657', '0414-5460657', '+58 414-5460657'];
    for (const variant of variants) {
      const identities = identifyPhone(variant);
      expect(identities.length).toBe(1);
      expect(identities[0]).toMatchObject({
        e164: '584145460657',
        countryCallingCode: '58',
        nationalNumber: '4145460657',
        region: 'VE',
      });
    }
    expect(identitiesMatch(identifyPhone('0414-5460657')[0]!, identifyPhone('+584145460657')[0]!)).toBe(
      true,
    );
  });

  it('WhatsApp paste variants resolve through the parser to the same identity', () => {
    const pastes = [
      'escríbeme al +58 414-5460657 porfa',
      'mi número es (0414) 546-0657, ¿me buscas?',
      'llámame al 414 546 0657 o al fijo',
    ];
    for (const paste of pastes) {
      const candidates = extractPhoneCandidates(paste);
      expect(candidates.length).toBeGreaterThanOrEqual(1);
      const identities = identifyPhone(candidates[0]!.raw);
      expect(identities[0]).toMatchObject({ e164: '584145460657', region: 'VE' });
    }
    expect(parsePhone('hola, mi número es +58 414-5460657, ¿me buscas?')).toMatchObject({
      kind: 'phone',
      raw: '+584145460657',
    });
  });

  it('synthetic internationals resolve via metadata, never hardcoded (TESTS ONLY)', () => {
    // Synthetic valid numbers — never in the fixture, tests only.
    expect(identifyPhone('+12025550143')).toMatchObject([
      { e164: '12025550143', countryCallingCode: '1', nationalNumber: '2025550143', region: 'US' },
    ]);
    expect(identifyPhone('+573001234567')).toMatchObject([
      { e164: '573001234567', countryCallingCode: '57', nationalNumber: '3001234567', region: 'CO' },
    ]);
    expect(identifyPhone('+34600123123')).toMatchObject([
      { e164: '34600123123', countryCallingCode: '34', nationalNumber: '600123123', region: 'ES' },
    ]);
  });
});

describe('slice A: phone negatives', () => {
  it('same-last-7 distinct numbers never match', () => {
    const anny = identifyPhone('0414-5460657')[0]!;
    const other = identifyPhone('4245460657')[0]!;
    expect(anny.e164).not.toBe(other.e164);
    expect(identitiesMatch(anny, other)).toBe(false);
    expect(normalizePhoneKeys('0414-5460657').some((k) => normalizePhoneKeys('4245460657').includes(k))).toBe(
      false,
    );
  });

  it('explicit +57/+1 are never VE-reinterpreted', () => {
    const co = identifyPhone('+573001234567');
    expect(co).toHaveLength(1);
    expect(co[0]!.region).toBe('CO');
    const us = identifyPhone('+14145460657');
    expect(us).toHaveLength(1);
    expect(us[0]!.region).toBe('US');
    // Same national digits as Anny Tovar, different country → no match.
    expect(identitiesMatch(us[0]!, identifyPhone('4145460657')[0]!)).toBe(false);
  });

  it('invalid input never crashes and matches nothing', async () => {
    expect(identifyPhone('+9991234567')).toEqual([
      { raw: '+9991234567', normalizedDigits: '9991234567' },
    ]);
    expect(identifyPhone('hola')).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'vokath-phone-neg-'));
    const store = await MockStore.create({
      fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
      statePath: join(dir, 'mock-state.json'),
    });
    expect(store.searchByPhone('+9991234567')).toEqual([]);
    expect(store.searchByPhone('hola')).toEqual([]);
  });

  it('+less full-international resolves when safely decidable, never a random country', () => {
    // VE metadata rejects these shapes, exactly one additional plan
    // accepts each — a single candidate, decided by metadata.
    expect(identifyPhone('12025550143')).toMatchObject([{ e164: '12025550143', region: 'US' }]);
    expect(identifyPhone('34674003172')).toMatchObject([{ e164: '34674003172', region: 'ES' }]);
    // A bare national shape stays legacy-VE by convention (indistinguishable
    // without `+`); the operator disambiguates with explicit `+CC`.
    expect(identifyPhone('2025550143')).toMatchObject([{ e164: '582025550143', region: 'VE' }]);
    // Row-level ambiguity still surfaces EVERY candidate: shared phones
    // match all owners, never one arbitrary pick (proven in UX tests 5/8).
  });
});

describe('slice A: expiry derived from FECHA QUE ACABA (injectable clock)', () => {
  it('DIAS>2 Vigente, 1-2 Por vencer, <=0 Vencido', () => {
    expect(deriveExpiryStatus('2026-09-07', '2026-09-01')).toMatchObject({ dias: 6, estatus: 'Vigente' });
    expect(deriveExpiryStatus('2026-09-07', '2026-09-05')).toMatchObject({ dias: 2, estatus: 'Por vencer' });
    expect(deriveExpiryStatus('2026-09-07', '2026-09-06')).toMatchObject({ dias: 1, estatus: 'Por vencer' });
    expect(deriveExpiryStatus('2026-09-07', '2026-09-07')).toMatchObject({ dias: 0, estatus: 'Vencido' });
    expect(deriveExpiryStatus('2026-09-07', '2026-09-10')).toMatchObject({ dias: -3, estatus: 'Vencido' });
    expect(deriveExpiryStatus(null, '2026-09-06')).toMatchObject({ dias: null, estatus: 'Sin dato' });
  });

  it('legacy DIAS/ESTATUS never govern the card', () => {
    const customer: Customer = {
      id: 'anny tovar',
      nombre: 'Anny Tovar',
      phones: ['4145460657'],
      subscriptions: [
        {
          servicio: 'flujotv',
          perfil: '1 PERFIL',
          fechaFin: '2026-09-01',
          paisCuenta: 'VE',
          estatusLegacy: 'VIGENTE',
          numeroRaw: '4145460657',
        },
      ],
    };
    // Sheet says VIGENTE, expiry says past → the card shows Vencido.
    expect(formatCustomerCard(customer, '2026-09-06')).toContain('Vencido');
    expect(formatCustomerCard(customer, '2026-09-06')).not.toContain('Vigente');
  });
});

describe('slice A: CLIENTE ≠ TELÉFONO grouping (domain layer)', () => {
  it('multi-service rows dedup into one customer; shared phones stay split', () => {
    const customers = groupRowsIntoCustomers([
      { ...row('Rafael minnesota', '16124418159'), servicio: 'flujotv' },
      { ...row('Rafael minnesota', '16124418159'), servicio: 'netflix' },
      row('Stefania Marmai (Gian)', '4141294973'),
      row('Iliana Rodriguez', '4141294973'),
    ]);
    expect(customers).toHaveLength(3);
    const rafael = customers.find((c) => c.nombre === 'Rafael minnesota')!;
    expect(rafael.subscriptions).toHaveLength(2);
    expect(rafael.phones).toEqual(['16124418159']);
  });

  it('multi-number cells fan out to every owned phone', () => {
    const [gerardo] = groupRowsIntoCustomers([row('Gerardo Hernandez', '4124086018 / 4242039835')]);
    expect(gerardo!.phones).toEqual(['4124086018', '4242039835']);
  });
});

// ---------------------------------------------------------------------------
// Search UX 1-9 (webhook, real fixture)
// ---------------------------------------------------------------------------

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

  buttons(): Array<{ text: string; callback_data: string }> {
    return this.messages().flatMap((entry) => entry.replyMarkup?.inline_keyboard.flat() ?? []);
  }
}

interface SliceWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter;
  drafts: DraftEngine;
  interactions: InteractionStore;
  repos: MockAccountRepositories;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<void>;
}

async function createSliceWorld(): Promise<SliceWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-slice-'));
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
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
    operatorTopics: new Map(),
  });
  let counter = 7000;
  return {
    app,
    client,
    interpreter,
    drafts,
    interactions,
    repos,
    nextUpdateId: () => {
      counter += 1;
      return counter;
    },
    post: async (update: unknown) => {
      await app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': testEnv.TELEGRAM_WEBHOOK_SECRET },
        payload: update,
      });
    },
  };
}

function sliceMessage(updateId: number, actorId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Operator' },
      chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
      text,
    },
  };
}

function sliceCallback(updateId: number, actorId: number, data: string): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Operator' },
      message: { message_id: 7, chat: { id: GROUP_CHAT_ID, type: 'supergroup' } },
      data,
    },
  };
}

describe('slice A: phone search UX 1-9 (webhook, real fixture)', () => {
  it('(1) fixture phone → result card (zero Gemini)', async () => {
    const world = await createSliceWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchCustomersByPhone');
    await world.post(sliceMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    expect(world.interpreter.calls).toBe(0);
    expect(searchSpy).toHaveBeenCalledWith('4145460657');
    expect(world.client.texts().at(-1)).toContain('Anny Tovar');
    await world.app.close();
  });

  it('(2) +58 form hits the same card (explicit +CC, zero Gemini)', async () => {
    const world = await createSliceWorld();
    await world.post(sliceMessage(world.nextUpdateId(), GABRIEL, '+58 414-5460657'));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('Anny Tovar');
    await world.app.close();
  });

  it('(3) separators do not matter (spaces/dashes/parens)', async () => {
    const world = await createSliceWorld();
    for (const variant of ['0414 546 0657', '0414-5460657', '(0414) 546-0657']) {
      await world.post(sliceMessage(world.nextUpdateId(), GABRIEL, variant));
      expect(world.client.texts().at(-1)).toContain('Anny Tovar');
    }
    await world.app.close();
  });

  it('(4) 1-client phone → direct summary card, no credentials', async () => {
    const world = await createSliceWorld();
    await world.post(sliceMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('Anny Tovar');
    expect(last).toContain('4145460657');
    expect(last).toContain('FlujoTV');
    expect(last).toContain('2026-09-07');
    expect(last).toContain('País cuenta: VE');
    const payload = JSON.stringify(world.client.sent);
    expect(payload).not.toContain('ncsa909');
    expect(payload).not.toContain('contrasena');
    expect(payload).not.toContain('CONTRASEÑA');
    expect(payload).not.toContain('Crear cliente');
    const labels = world.client.buttons().map((b) => b.text);
    expect(labels).toContain('🔎Buscar otro');
    expect(labels).toContain('←Volver');
    await world.app.close();
  });

  it('(5) shared phone → disambiguation list with owner-bound buttons', async () => {
    const world = await createSliceWorld();
    await world.post(sliceMessage(world.nextUpdateId(), GABRIEL, '4141294973'));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('Stefania Marmai (Gian)');
    expect(last).toContain('Iliana Rodriguez');
    expect(last).toMatch(/elige uno/i);
    const labels = world.client.buttons().map((b) => b.text);
    expect(labels).toContain('1️⃣ Ver cliente');
    expect(labels).toContain('2️⃣ Ver cliente');
    await world.app.close();
  });

  it('(6) unknown phone → not-found without Crear cliente', async () => {
    const world = await createSliceWorld();
    await world.post(sliceMessage(world.nextUpdateId(), GABRIEL, '04240000000'));
    expect(world.interpreter.calls).toBe(0);
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('No encontrado');
    expect(last).toContain('No encontramos ningún cliente asociado a ese número.');
    expect(last).not.toContain('Crear cliente');
    const labels = world.client.buttons().map((b) => b.text);
    expect(labels).toContain('🔎Buscar otro');
    expect(labels).toContain('←Volver');
    await world.app.close();
  });

  it('(7) multi-phone customer resolves from either number', async () => {
    const world = await createSliceWorld();
    for (const variant of ['4124086018', '4242039835', '+58 424-2039835']) {
      await world.post(sliceMessage(world.nextUpdateId(), GABRIEL, variant));
      const last = world.client.texts().at(-1) ?? '';
      expect(last).toContain('Gerardo Hernandez');
      expect(last).toContain('4124086018');
      expect(last).toContain('4242039835');
    }
    await world.app.close();
  });

  it('(8) phones shared across customers stay split (repo level)', async () => {
    const world = await createSliceWorld();
    const customers = await world.repos.searchCustomersByPhone('34641375927');
    const names = customers.map((c) => c.nombre).sort();
    expect(names).toContain('Libardo Perez');
    expect(names).toContain('Raul Villa');
    // Same cell, different people → separate customers, never merged.
    expect(customers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(customers.map((c) => c.id)).size).toBe(customers.length);
    await world.app.close();
  });

  it('(9) selecting a result opens its card and records lastSelectedCustomer', async () => {
    const world = await createSliceWorld();
    await world.post(sliceMessage(world.nextUpdateId(), GABRIEL, '4141294973'));
    const search = world.interactions
      .snapshot()
      .find((i) => i.ownerTelegramUserId === GABRIEL && i.type === 'SEARCH');
    if (search === undefined) {
      throw new Error('SEARCH interaction missing');
    }
    const expected = (await world.repos.searchCustomersByPhone('4141294973'))[0]!;
    await world.post(sliceCallback(world.nextUpdateId(), GABRIEL, callbackDataFor('view0', search.id)));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain(expected.nombre);
    expect(last).toContain('País cuenta:');
    const updated = world.interactions.get(search.id);
    expect(updated?.state['selectedCustomer']).toMatchObject({ nombre: expected.nombre });
    expect(updated?.state['view']).toBe('customer-detail');
    await world.app.close();
  });
});

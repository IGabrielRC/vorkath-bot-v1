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
import type { CredentialBundle } from '../src/mock/credentials';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';
import {
  accountDisambiguationKeyboard,
  callbackDataFor,
  credentialDisambiguationKeyboard,
  type CallbackAction,
} from '../src/telegram/keyboards';
import {
  renderCredentialAssignmentList,
  renderCredentialCard,
} from '../src/telegram/render';
import {
  credentialOptionLabels,
  shortButtonIdentifier,
} from '../src/tools/credentials';

/**
 * PRESENTATION ONLY — every assignment shows its account identifier.
 * Rafael minnesota (`16124418159`, 4 bundles: FlujoTV shared `cmaxnet002`,
 * FlujoTV complete `maxnet012`, FlujoTV `cmaxnet004`, Netflix
 * `dasdsadasda@gmail.com`); cmaxnet001 shared by Anny/Neisis/Roman.
 */

const GABRIEL = 1057242322;
const GROUP_CHAT_ID = -1005550001;

const NAMES: Record<number, string> = { [GABRIEL]: 'Gabriel' };

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  TELEGRAM_BOT_TOKEN: 'tok-test-secret',
  TELEGRAM_WEBHOOK_SECRET: 'wh-test-secret-long-enough',
  AUTHORIZED_TELEGRAM_USER_IDS: `${GABRIEL}`,
  AUTHORIZED_TELEGRAM_CHAT_IDS: `${GROUP_CHAT_ID}`,
  GEMINI_API_KEY: 'key-test-secret',
  GEMINI_MODEL: 'gemini-2.0-flash',
  PUBLIC_BASE_URL: 'https://example.com',
  REGISTER_TELEGRAM_WEBHOOK: 'false',
  MOCK_STATE_PATH: '/data/mock-state.json',
  DRAFTS_STATE_PATH: '/data/drafts-state.json',
};

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

  texts(): string[] {
    return this.sent
      .filter((entry) => entry.kind === 'send' || entry.kind === 'edit')
      .map((entry) => (entry.payload as SentPayload).text);
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
}

class RecordingInterpreter extends StubIntentInterpreter {
  override async interpret(text: string, ctx: SessionCtx): Promise<Intent> {
    return super.interpret(text, ctx);
  }
}

interface IdentWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  repos: MockAccountRepositories;
  audits: AuditEvent[];
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

async function createIdentWorld(): Promise<IdentWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-ident-'));
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const client = new StubTelegramClient();
  const audits: AuditEvent[] = [];
  const repos = new MockAccountRepositories(store);
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions: new SessionStore(),
    drafts: new DraftEngine(),
    interactions: new InteractionStore(),
    interpreter: new RecordingInterpreter(),
    repos,
    client,
    auditor: createAuditor((event) => {
      audits.push(event);
    }),
  });
  let counter = 91000;
  return {
    app,
    client,
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

function identMessage(updateId: number, actorId: number, text: string): unknown {
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

function identCallback(updateId: number, actorId: number, data: string): unknown {
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

function lastOwnedInteractionId(world: IdentWorld): string {
  const owned = world.client.lastButtons().find((button) => button.callback_data !== undefined);
  return owned?.callback_data?.split(':')[2] ?? '';
}

async function tapView(world: IdentWorld, actorId: number, index: number): Promise<void> {
  const data = callbackDataFor(`view${index}` as CallbackAction, lastOwnedInteractionId(world));
  await world.post(identCallback(world.nextUpdateId(), actorId, data));
}

async function searchRafael(world: IdentWorld): Promise<CredentialBundle[]> {
  await world.post(identMessage(world.nextUpdateId(), GABRIEL, '16124418159'));
  const customers = await world.repos.searchCustomersByPhone('16124418159');
  const index = customers.findIndex((customer) => customer.nombre === 'Rafael minnesota');
  expect(index).toBeGreaterThanOrEqual(0);
  await tapView(world, GABRIEL, index);
  expect(world.client.lastText()).toContain('Rafael minnesota');
  await world.post(identMessage(world.nextUpdateId(), GABRIEL, 'dame los datos'));
  expect(world.client.lastText()).toContain('¿Qué datos necesitas? (4)');
  return world.repos.getCredentialBundlesForCustomer('rafael minnesota');
}

function stripOperatorLabel(text: string): string {
  return text.replace(/\n👤 Operador: [^\n]*$/, '');
}

describe('assignment identifiers (presentation only)', () => {
  it('FlujoTV shared blocks show the username identifier', async () => {
    const world = await createIdentWorld();
    const bundles = await searchRafael(world);
    const shared = bundles.filter((bundle) => bundle.accountType === 'flujotv-shared');
    expect(shared.length).toBeGreaterThan(0);
    const card = stripOperatorLabel(world.client.lastText());
    for (const bundle of shared) {
      expect(card).toContain(bundle.accountIdentifier);
    }
    await world.app.close();
  });

  it('FlujoTV complete blocks show their identifier', async () => {
    const world = await createIdentWorld();
    const bundles = await searchRafael(world);
    const complete = bundles.filter((bundle) => bundle.accountType === 'flujotv-complete');
    expect(complete.length).toBeGreaterThan(0);
    const card = stripOperatorLabel(world.client.lastText());
    for (const bundle of complete) {
      expect(card).toContain(bundle.accountIdentifier);
      expect(card).toContain(bundle.profile);
    }
    await world.app.close();
  });

  it('Netflix blocks show the account email', async () => {
    const world = await createIdentWorld();
    const bundles = await searchRafael(world);
    const netflix = bundles.filter((bundle) => bundle.service === 'netflix');
    expect(netflix.length).toBeGreaterThan(0);
    const card = stripOperatorLabel(world.client.lastText());
    for (const bundle of netflix) {
      // Full email in the block — never invented, never truncated there.
      expect(card).toContain(bundle.accountIdentifier);
      expect(bundle.accountIdentifier).toContain('@');
    }
    await world.app.close();
  });

  it('all three button types show identifiers (credential + account disambiguation)', async () => {
    const world = await createIdentWorld();
    const bundles = await searchRafael(world);
    const buttons = world.client.lastButtons().map((button) => button.text);
    const labels = credentialOptionLabels(bundles);
    // Credential buttons: shared + complete + netflix each name an identifier.
    expect(buttons.some((text) => text.includes('cmaxnet002'))).toBe(true);
    expect(buttons.some((text) => text.includes('cmaxnet004'))).toBe(true);
    expect(labels.some((label) => label.includes('FlujoTV'))).toBe(true);
    expect(labels.some((label) => label.includes('Netflix'))).toBe(true);
    // Netflix email (21 chars) truncates visibly but stays recognizable.
    const netflixLabel = labels.find((label) => label.includes('Netflix')) ?? '';
    expect(netflixLabel).toContain('dasdsadasda@gmail.co');
    expect(netflixLabel).toContain('…');
    // Account disambiguation buttons name service + identifier per account.
    const disambiguation = accountDisambiguationKeyboard(
      [
        { servicio: 'flujotv', identifier: 'cmaxnet002' },
        { servicio: 'netflix', identifier: 'dasdsadasda@gmail.com' },
      ],
      { interactionId: 'abc123' },
    );
    const disLabels = disambiguation.inline_keyboard.flat().map((button) => button.text);
    expect(disLabels.some((text) => text.includes('FlujoTV') && text.includes('cmaxnet002'))).toBe(
      true,
    );
    expect(disLabels.some((text) => text.includes('Netflix') && text.includes('dasdsadasda'))).toBe(
      true,
    );
    await world.app.close();
  });

  it('no client-name repetition in context — the identifier differentiates', async () => {
    const world = await createIdentWorld();
    await searchRafael(world);
    const card = stripOperatorLabel(world.client.lastText());
    expect(card).not.toContain('Rafael minnesota · Rafael minnesota');
    // Single-client scope: blocks carry identifiers, never the client name.
    const heads = card.split('\n').filter((line) => /^[1-5]️⃣|^[0-9]/.test(line) || line.includes('·'));
    expect(heads.some((line) => line.includes('Rafael minnesota'))).toBe(false);
    await world.app.close();
  });

  it('same-identifier pairs stay differentiated by profile/slot', async () => {
    const card = renderCredentialAssignmentList(2, [
      {
        numeral: '1️⃣',
        serviceLabel: 'Netflix',
        profile: '1 PERFIL (1)',
        disambiguator: 'cuenta@gmail.com',
        estatus: 'Vigente',
        dias: 10,
        fechaFin: '2026-10-17',
      },
      {
        numeral: '2️⃣',
        serviceLabel: 'Netflix',
        profile: '1 PERFIL (2)',
        disambiguator: 'cuenta@gmail.com',
        estatus: 'Vigente',
        dias: 10,
        fechaFin: '2026-10-17',
      },
    ]);
    expect(card).toContain('1️⃣ Netflix · 1 PERFIL (1) · cuenta@gmail.com');
    expect(card).toContain('2️⃣ Netflix · 1 PERFIL (2) · cuenta@gmail.com');
  });

  it('long identifiers render safely: full in blocks/cards, truncated with … on buttons', async () => {
    const longId = 'una-cuenta-extremadamente-larga-para-probar-truncado-123456789@gmail.com';
    const card = renderCredentialAssignmentList(1, [
      {
        numeral: '1️⃣',
        serviceLabel: 'Netflix',
        profile: '1 PERFIL (1)',
        disambiguator: longId,
        estatus: 'Vigente',
        dias: 10,
        fechaFin: '2026-10-17',
      },
    ]);
    // Blocks keep the full identifier (escaped, markup intact).
    expect(card).toContain(longId);
    // Buttons truncate visibly in a controlled way.
    expect(shortButtonIdentifier(longId)).toBe(`${longId.slice(0, 20)}…`);
    expect(shortButtonIdentifier(longId)).toContain('…');
    // Credential card keeps the full identifier.
    const credential = renderCredentialCard({
      serviceLabel: 'Netflix',
      accountIdentifier: longId,
      accountPassword: 'secreta123',
      profile: '1 PERFIL (1)',
      accountType: 'netflix-profile',
      customerName: 'Cliente Prueba',
      fechaFin: '2026-10-17',
    });
    expect(credential).toContain(longId);
    expect(credential).not.toContain('…');
  });

  it('callbacks carry stable assignment ids — never derived from truncated labels', async () => {
    const world = await createIdentWorld();
    await searchRafael(world);
    for (const button of world.client.lastButtons()) {
      if (button.callback_data === undefined || button.text.includes('Volver')) {
        continue;
      }
      expect(button.callback_data).toMatch(/^v1:w[0-4]:[0-9a-f]+$/);
      expect(button.callback_data).not.toContain('cmaxnet');
      expect(button.callback_data).not.toContain('gmail');
    }
    await world.app.close();
  });

  it('every button resolves exactly to its own assignment card', async () => {
    const world = await createIdentWorld();
    const bundles = await searchRafael(world);
    expect(bundles).toHaveLength(4);
    for (let index = 0; index < bundles.length; index += 1) {
      await tapView(world, GABRIEL, index);
      const card = stripOperatorLabel(world.client.lastText());
      const expected = bundles[index] as CredentialBundle;
      expect(card).toContain('🔐 DATOS DE ACCESO');
      expect(card).toContain(expected.accountIdentifier);
      if (expected.accountType === 'flujotv-complete') {
        // Complete FlujoTV keeps its own model: fixed Completa label, never a profile-number shape.
        expect(card).toContain('Completa / Exclusiva');
      } else {
        expect(card).toContain(expected.profile);
      }
      // Back to the selector for the next option.
      const data = world.client.lastButtons().find((button) => button.text === '← Servicios')
        ?.callback_data;
      expect(data).toBeDefined();
      await world.post(identCallback(world.nextUpdateId(), GABRIEL, data as string));
      expect(world.client.lastText()).toContain('¿Qué datos necesitas? (4)');
    }
    await world.app.close();
  });

  it('credential card keeps the full Netflix identifier (no button truncation)', async () => {
    const world = await createIdentWorld();
    const bundles = await searchRafael(world);
    const netflixIndex = bundles.findIndex((bundle) => bundle.service === 'netflix');
    expect(netflixIndex).toBeGreaterThanOrEqual(0);
    await tapView(world, GABRIEL, netflixIndex);
    const card = stripOperatorLabel(world.client.lastText());
    const netflix = bundles[netflixIndex] as CredentialBundle;
    expect(card).toContain(netflix.accountIdentifier);
    expect(card).not.toContain(`${netflix.accountIdentifier.slice(0, 20)}…`);
    await world.app.close();
  });

  it('escaping stays intact with hostile identifiers and profiles', async () => {
    const card = renderCredentialAssignmentList(1, [
      {
        numeral: '1️⃣',
        serviceLabel: 'Netflix',
        profile: '1 PERFIL <b>(1)</b>',
        disambiguator: 'cmax<script>net002 & co',
        estatus: 'Vigente',
        dias: 41,
        fechaFin: '2026-10-17',
      },
    ]);
    expect(card).toContain('1 PERFIL &lt;b&gt;(1)&lt;/b&gt;');
    expect(card).toContain('cmax&lt;script&gt;net002 &amp; co');
    expect(card).not.toContain('<b>(1)</b>');
    expect(card).not.toContain('<script>');
    const labels = credentialDisambiguationKeyboard(['FlujoTV · 1 PERFIL · cmax<script>002'], {
      interactionId: 'abc123',
    });
    expect(labels.inline_keyboard.flat()[0]?.text).toContain('cmax<script>002');
  });
});

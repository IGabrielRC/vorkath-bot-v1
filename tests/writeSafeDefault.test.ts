import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  INTENT_NAMES,
  StubIntentInterpreter,
  type Intent,
  type IntentInterpreter,
} from '../src/ai/intentInterpreter';
import { parseAuthorizedChatIds, parseAuthorizedIds } from '../src/auth/allowlist';
import { buildApp } from '../src/app';
import type { Env } from '../src/config/env';
import { DraftEngine } from '../src/drafts/engine';
import { InteractionStore } from '../src/interactions/interactions';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import {
  isExplicitCreateRequest,
  parseCreateTest,
  parseFast,
} from '../src/parser/fast';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';
import { esc, renderLegacyNotFound } from '../src/telegram/render';
import { UNKNOWN_TEXT } from '../src/telegram/webhook';
import { INTENT_MUTATION_POLICY } from '../src/tools/requirements';

/**
 * WRITE safe-default hotfix (fail-closed for mutations).
 *
 * Root cause: `revisa prueba&test<123` fell through L2 to `none` and L3
 * mapped the loose "prueba"/"test" tokens to CREATE_TEST_DRAFT; the L3
 * branch then built a draft even with zero months. An ambiguous/invalid
 * input landed in 📝 OPERACIÓN PENDIENTE.
 *
 * Invariant locked here: CREATE_TEST_DRAFT fires ONLY on an unequivocal
 * creation expression (verb + noun); consult phrases prioritize
 * READ/SEARCH; UNKNOWN (or a rogue WRITE intent over non-explicit text)
 * NEVER executes a critical mutation.
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

  async answerCallbackQuery(callbackQueryId: string): Promise<unknown> {
    this.sent.push({ kind: 'answer', payload: { callbackQueryId } });
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
}

interface SafeWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter;
  drafts: DraftEngine;
  interactions: InteractionStore;
  repos: MockAccountRepositories;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

async function createSafeWorld(overrides?: {
  interpreter?: IntentInterpreter;
}): Promise<SafeWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-safedefault-'));
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
    interpreter: overrides?.interpreter ?? interpreter,
    repos,
    client,
    operatorTopics: new Map(),
  });
  let counter = 9000;
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

function safeMessage(updateId: number, actorId: number, text: string): unknown {
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

/** Forced interpreter: simulates a rogue/overgeneralizing L3 verdict. */
function forcedIntent(intent: Intent): IntentInterpreter {
  return {
    interpret: async () => ({ ...intent, params: { ...intent.params } }),
  };
}

function draftOf(world: SafeWorld, userId: number) {
  return world.drafts.get({ chatId: GROUP_CHAT_ID, userId });
}

describe('write safe-default: explicit-create gate (unit)', () => {
  it('accepts unequivocal creation expressions only (verb + noun)', () => {
    for (const phrase of [
      'crea una operación de prueba',
      'crea una operación de prueba de 5 meses',
      'quiero crear una prueba',
      'quiero abrir una prueba',
      'hazme una demo',
      'crea una demo',
      'crea una prueba demo',
      'opera un test',
    ]) {
      expect(isExplicitCreateRequest(phrase)).toBe(true);
    }
  });

  it('rejects bare nouns and consult phrases (never WRITE)', () => {
    for (const phrase of [
      'prueba',
      'demo',
      'test',
      'prueba&test<123',
      'revisa prueba&test<123',
      'revisa la prueba',
      'revisa la prueba de 2 meses',
      'busca test',
      'consulta demo',
      'hola qué tal',
    ]) {
      expect(isExplicitCreateRequest(phrase)).toBe(false);
    }
  });

  it('parseCreateTest never fires on consult phrases, even with months', () => {
    expect(parseCreateTest('crea una prueba de 2 meses')).toEqual({
      kind: 'createTest',
      months: 2,
    });
    expect(parseCreateTest('revisa la prueba de 2 meses')).toBeNull();
    expect(parseCreateTest('revisa prueba&test<123')).toBeNull();
    expect(parseFast('revisa prueba&test<123')).toEqual({ kind: 'none' });
  });

  it('stub maps bare nouns to UNKNOWN and consult phrases to OPEN_SEARCH', async () => {
    const stub = new StubIntentInterpreter();
    for (const phrase of ['prueba', 'demo', 'test', 'prueba&test<123']) {
      expect(await stub.interpret(phrase, { userId: GABRIEL })).toMatchObject({
        name: 'UNKNOWN',
      });
    }
    for (const phrase of ['revisa prueba&test<123', 'revisa la prueba']) {
      const intent = await stub.interpret(phrase, { userId: GABRIEL });
      expect(intent.name).not.toBe('CREATE_TEST_DRAFT');
    }
    expect(
      await stub.interpret('revisa prueba&test<123', { userId: GABRIEL }),
    ).toMatchObject({ name: 'OPEN_SEARCH' });
    // Explicit phrases still draft (no regression).
    for (const phrase of [
      'quiero crear una prueba',
      'hazme una demo',
      'opera un test',
      'crea una demo',
    ]) {
      expect(await stub.interpret(phrase, { userId: GABRIEL })).toMatchObject({
        name: 'CREATE_TEST_DRAFT',
      });
    }
  });
});

describe('write safe-default: smoke case never drafts (webhook)', () => {
  it('`revisa prueba&test<123` never becomes CREATE_TEST_DRAFT (SEARCH attempt, no draft)', async () => {
    const world = await createSafeWorld();
    const draftSpy = vi.spyOn(world.drafts, 'create');
    await world.post(safeMessage(world.nextUpdateId(), GABRIEL, 'revisa prueba&test<123'));
    expect(draftSpy).not.toHaveBeenCalled();
    expect(draftOf(world, GABRIEL)).toBeUndefined();
    expect(world.client.findButton('✅Confirmar')).toBeUndefined();
    const last = world.client.texts().at(-1) ?? '';
    expect(last).not.toMatch(/borrador|pendiente|confirma/i);
    await world.app.close();
  });

  it('`revisa cuenta-inexistente-999` runs the deterministic search → CUENTA NO ENCONTRADA', async () => {
    const world = await createSafeWorld();
    const searchSpy = vi.spyOn(world.repos, 'searchServiceAccounts');
    const draftSpy = vi.spyOn(world.drafts, 'create');
    await world.post(safeMessage(world.nextUpdateId(), GABRIEL, 'revisa cuenta-inexistente-999'));
    expect(searchSpy).toHaveBeenCalledWith('cuenta-inexistente-999');
    expect(world.client.texts().at(-1)).toContain('CUENTA NO ENCONTRADA');
    expect(draftSpy).not.toHaveBeenCalled();
    expect(draftOf(world, GABRIEL)).toBeUndefined();
    await world.app.close();
  });

  it('`prueba&test<123` is safe UNKNOWN (defined route, never WRITE)', async () => {
    const world = await createSafeWorld();
    const draftSpy = vi.spyOn(world.drafts, 'create');
    await world.post(safeMessage(world.nextUpdateId(), GABRIEL, 'prueba&test<123'));
    expect(draftSpy).not.toHaveBeenCalled();
    expect(draftOf(world, GABRIEL)).toBeUndefined();
    expect(world.client.texts().at(-1)).toContain(UNKNOWN_TEXT);
    await world.app.close();
  });

  it('`crea una operación de prueba` still drafts (explicit shell, missing months asked)', async () => {
    const world = await createSafeWorld();
    await world.post(safeMessage(world.nextUpdateId(), GABRIEL, 'crea una operación de prueba'));
    expect(draftOf(world, GABRIEL)?.status).toBe('open');
    expect(world.client.findButton('✅Confirmar')).toBeDefined();
    await world.app.close();
  });

  it('`crea una operación de prueba de 5 meses` drafts with months=5', async () => {
    const world = await createSafeWorld();
    await world.post(
      safeMessage(world.nextUpdateId(), GABRIEL, 'crea una operación de prueba de 5 meses'),
    );
    expect(draftOf(world, GABRIEL)?.months).toBe(5);
    expect(world.client.texts().at(-1)).toMatch(/confirma/i);
    await world.app.close();
  });

  it('ambiguous battery creates no draft and offers no Confirmar (draft store empty)', async () => {
    for (const phrase of [
      'prueba',
      'demo',
      'test',
      'revisa la prueba',
      'busca test',
      'revisa prueba&test<123',
      'prueba&test<123',
    ]) {
      const world = await createSafeWorld();
      const draftSpy = vi.spyOn(world.drafts, 'create');
      await world.post(safeMessage(world.nextUpdateId(), GABRIEL, phrase));
      expect(draftSpy, phrase).not.toHaveBeenCalled();
      expect(draftOf(world, GABRIEL), phrase).toBeUndefined();
      expect(world.client.findButton('✅Confirmar'), phrase).toBeUndefined();
      await world.app.close();
    }
  });
});

describe('write safe-default: dispatch-level contract (rogue L3 + UNKNOWN)', () => {
  it('a rogue CREATE_TEST_DRAFT over non-explicit text builds no draft (UNKNOWN fallback)', async () => {
    const world = await createSafeWorld({
      interpreter: forcedIntent({ name: 'CREATE_TEST_DRAFT', params: {} }),
    });
    const draftSpy = vi.spyOn(world.drafts, 'create');
    await world.post(safeMessage(world.nextUpdateId(), GABRIEL, 'revisa prueba&test<123'));
    expect(draftSpy).not.toHaveBeenCalled();
    expect(draftOf(world, GABRIEL)).toBeUndefined();
    expect(world.client.texts().at(-1)).toContain(UNKNOWN_TEXT);
    await world.app.close();
  });

  it('a rogue CREATE_TEST_DRAFT with months but non-explicit text still builds no draft', async () => {
    const world = await createSafeWorld({
      interpreter: forcedIntent({ name: 'CREATE_TEST_DRAFT', params: { months: 5 } }),
    });
    const draftSpy = vi.spyOn(world.drafts, 'create');
    await world.post(safeMessage(world.nextUpdateId(), GABRIEL, 'prueba&test<123'));
    expect(draftSpy).not.toHaveBeenCalled();
    expect(draftOf(world, GABRIEL)).toBeUndefined();
    await world.app.close();
  });

  it('a rogue CREATE_TEST_DRAFT carrying an identifier degrades to READ (search, no draft)', async () => {
    const world = await createSafeWorld({
      interpreter: forcedIntent({ name: 'CREATE_TEST_DRAFT', params: { identifier: 'maxnet050' } }),
    });
    const draftSpy = vi.spyOn(world.drafts, 'create');
    await world.post(safeMessage(world.nextUpdateId(), GABRIEL, 'revisa prueba&test<123'));
    expect(draftSpy).not.toHaveBeenCalled();
    expect(draftOf(world, GABRIEL)).toBeUndefined();
    expect(world.client.texts().at(-1)).toContain('Jackson Amaya');
    await world.app.close();
  });

  it('INTENT_MUTATION_POLICY classifies every intent (future WRITE intents fail compile until classified)', () => {
    expect(Object.keys(INTENT_MUTATION_POLICY).sort()).toEqual([...INTENT_NAMES].sort());
    expect(INTENT_MUTATION_POLICY['UNKNOWN']).toBe('none');
  });

  it('UNKNOWN intent never executes a critical mutation, even over explicit-looking text', async () => {
    for (const phrase of [
      'revisa prueba&test<123',
      'quiero crear una prueba',
      'crea una prueba demo',
    ]) {
      const world = await createSafeWorld({
        interpreter: forcedIntent({ name: 'UNKNOWN', params: {} }),
      });
      const createSpy = vi.spyOn(world.drafts, 'create');
      const updateSpy = vi.spyOn(world.drafts, 'update');
      const confirmSpy = vi.spyOn(world.drafts, 'confirm');
      const cancelSpy = vi.spyOn(world.drafts, 'cancel');
      await world.post(safeMessage(world.nextUpdateId(), GABRIEL, phrase));
      expect(createSpy, phrase).not.toHaveBeenCalled();
      expect(updateSpy, phrase).not.toHaveBeenCalled();
      expect(confirmSpy, phrase).not.toHaveBeenCalled();
      expect(cancelSpy, phrase).not.toHaveBeenCalled();
      expect(draftOf(world, GABRIEL), phrase).toBeUndefined();
      expect(world.client.texts().at(-1), phrase).toContain(UNKNOWN_TEXT);
      expect(world.client.findButton('✅Confirmar'), phrase).toBeUndefined();
      await world.app.close();
    }
  });
});

describe('write safe-default: hostile identifier rendering stays escaped (unit)', () => {
  it('escapes & < > in the smoke identifier through the not-found path', () => {
    expect(esc('prueba&test<123')).toBe('prueba&amp;test&lt;123');
    const text = renderLegacyNotFound('prueba&test<123');
    expect(text).toContain('prueba&amp;test&lt;123');
    expect(text).not.toContain('prueba&test<123');
    const stripped = text.replace(/<\/?b>/g, '');
    expect(stripped).not.toContain('<');
    expect(stripped).not.toContain('>');
  });
});

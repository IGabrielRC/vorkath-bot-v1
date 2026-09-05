import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  StubIntentInterpreter,
  type Intent,
  type IntentInterpreter,
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
import type { AnswerCallbackOpts, TelegramClient } from '../src/telegram/client';
import { CALLBACK_MAX_BYTES, HOME_TEXT } from '../src/telegram/keyboards';
import { CANCELLED_TEXT } from '../src/telegram/webhook';

/**
 * Interaction-ownership suite (shared group, two operators, one chat).
 *
 * Actor/chat ids here are TEST-ONLY values. Business logic never
 * hardcodes them; production reads AUTHORIZED_TELEGRAM_USER_IDS /
 * CHAT_IDS from env.
 */
const GABRIEL = 1057242322;
const EDWARD = 941030473;
const GROUP_CHAT_ID = -1005550001;
const FOREIGN_CHAT_ID = -1009998887;

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
  INTERACTIONS_STATE_PATH: '/data/interactions-state.json',
};

interface MarkupButton {
  text: string;
  callback_data: string;
}

interface SentPayload {
  chatId: number;
  text: string;
  replyMarkup?: { inline_keyboard: MarkupButton[][] };
}

class StubTelegramClient implements TelegramClient {
  readonly sent: Array<{ kind: 'send' | 'edit' | 'answer'; payload: unknown }> = [];

  async sendMessage(opts: SentPayload): Promise<unknown> {
    this.sent.push({ kind: 'send', payload: opts });
    return { ok: true };
  }

  async editMessageText(
    opts: SentPayload & { messageId: number },
  ): Promise<unknown> {
    this.sent.push({ kind: 'edit', payload: opts });
    return { ok: true };
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    opts?: AnswerCallbackOpts,
  ): Promise<unknown> {
    this.sent.push({
      kind: 'answer',
      payload: { callbackQueryId, ...(opts?.text !== undefined ? { text: opts.text } : {}) },
    });
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

  /** Latest button with this exact text across all sent/edited markups. */
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

  /** Every button of the most recent sent/edited message. */
  lastButtons(): MarkupButton[] {
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

/** Records every Gemini context to prove per-actor isolation. */
class RecordingInterpreter implements IntentInterpreter {
  readonly inner = new StubIntentInterpreter();
  readonly contexts: SessionCtx[] = [];

  get calls(): number {
    return this.inner.calls;
  }

  async interpret(text: string, ctx: SessionCtx): Promise<Intent> {
    this.contexts.push({ ...ctx });
    return this.inner.interpret(text, ctx);
  }
}

interface OwnerWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter | RecordingInterpreter;
  sessions: SessionStore;
  drafts: DraftEngine;
  interactions: InteractionStore;
  auditEvents: AuditEvent[];
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

async function createOwnerWorld(
  interpreter?: StubIntentInterpreter | RecordingInterpreter,
  chatIds = `${GROUP_CHAT_ID}`,
): Promise<OwnerWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-own-'));
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const client = new StubTelegramClient();
  const activeInterpreter = interpreter ?? new StubIntentInterpreter();
  const sessions = new SessionStore();
  const drafts = new DraftEngine();
  const interactions = new InteractionStore();
  const auditEvents: AuditEvent[] = [];
  const env: Env = { ...testEnv, AUTHORIZED_TELEGRAM_CHAT_IDS: chatIds };
  const app = buildApp(env, {
    allowlist: parseAuthorizedIds(env.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(env.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions,
    drafts,
    interactions,
    interpreter: activeInterpreter,
    repos: new MockAccountRepositories(store),
    client,
    auditor: createAuditor((event) => {
      auditEvents.push(event);
    }),
    draftsStatePath: join(dir, 'drafts-state.json'),
    interactionsStatePath: join(dir, 'interactions-state.json'),
  });
  let counter = 9000;
  return {
    app,
    client,
    interpreter: activeInterpreter,
    sessions,
    drafts,
    interactions,
    auditEvents,
    nextUpdateId: () => {
      counter += 1;
      return counter;
    },
    post: async (update: unknown) => {
      const response = await app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET },
        payload: update,
      });
      return { status: response.statusCode, body: response.json() as unknown };
    },
  };
}

const NAMES: Record<number, string> = { [GABRIEL]: 'Gabriel', [EDWARD]: 'Edward' };

function groupMessage(
  updateId: number,
  actorId: number,
  text: string,
  chatId: number = GROUP_CHAT_ID,
  replyToText?: string,
): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Stranger' },
      chat: { id: chatId, type: 'supergroup' },
      text,
      ...(replyToText !== undefined
        ? {
            reply_to_message: {
              message_id: 2,
              from: { id: 999, first_name: 'VokathBot', is_bot: true },
              chat: { id: chatId, type: 'supergroup' },
              text: replyToText,
            },
          }
        : {}),
    },
  };
}

function groupCallback(
  updateId: number,
  actorId: number,
  data: string,
  chatId: number = GROUP_CHAT_ID,
): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Stranger' },
      message: { message_id: 7, chat: { id: chatId, type: 'supergroup' } },
      data,
    },
  };
}

const BOUND_RE = /^v1:[a-z0-9]+:[0-9a-f]{8}$/;

async function gabrielHomeOperar(world: OwnerWorld): Promise<string> {
  await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
  const operar = world.client.findButton('⚡OPERAR');
  if (operar === undefined) {
    throw new Error('Gabriel home OPERAR button missing');
  }
  return operar;
}

describe('A. Home ownership (1–4)', () => {
  it('(1) /start creates a per-actor Home interaction owned by Gabriel', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const active = world.interactions.getActive(GROUP_CHAT_ID, GABRIEL);
    expect(active?.type).toBe('HOME');
    expect(active?.ownerTelegramUserId).toBe(GABRIEL);
    expect(active?.ownerName).toBe('Gabriel');
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Gabriel');
    for (const button of world.client.lastButtons()) {
      expect(button.callback_data).toMatch(BOUND_RE);
      expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(
        CALLBACK_MAX_BYTES,
      );
    }
    await world.app.close();
  });

  it('(2) Edward /start coexists with its own Home interaction', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, '/start'));
    const gabriel = world.interactions.getActive(GROUP_CHAT_ID, GABRIEL);
    const edward = world.interactions.getActive(GROUP_CHAT_ID, EDWARD);
    expect(gabriel?.id).toBeDefined();
    expect(edward?.id).toBeDefined();
    expect(gabriel?.id).not.toBe(edward?.id);
    expect(edward?.ownerTelegramUserId).toBe(EDWARD);
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Edward');
    await world.app.close();
  });

  it('(3) Edward tapping Gabriel Home button is rejected with the toast', async () => {
    const world = await createOwnerWorld();
    const gabrielOperar = await gabrielHomeOperar(world);
    const before = world.client.messageCount();
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, gabrielOperar));
    expect(world.client.answers().at(-1)).toMatchObject({
      text: 'Esta acción pertenece a Gabriel.',
    });
    expect(world.client.messageCount()).toBe(before);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })).toBeUndefined();
    expect(world.interactions.getActive(GROUP_CHAT_ID, EDWARD)).toBeUndefined();
    await world.app.close();
  });

  it('(4) Gabriel tapping Edward Home button is rejected in reverse', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, '/start'));
    const edwardBuscar = world.client.findButton('🔎BUSCAR');
    if (edwardBuscar === undefined) {
      throw new Error('Edward home BUSCAR button missing');
    }
    const before = world.client.messageCount();
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, edwardBuscar));
    expect(world.client.answers().at(-1)).toMatchObject({
      text: 'Esta acción pertenece a Edward.',
    });
    expect(world.client.messageCount()).toBe(before);
    await world.app.close();
  });
});

describe('B. Search isolation (5–10)', () => {
  it('(5) Gabriel phone search creates an owned SEARCH interaction with bound buttons', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    const active = world.interactions.getActive(GROUP_CHAT_ID, GABRIEL);
    expect(active?.type).toBe('SEARCH');
    expect(active?.ownerTelegramUserId).toBe(GABRIEL);
    expect(world.client.texts().at(-1)).toContain('Anny Tovar');
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Gabriel');
    const buttons = world.client.lastButtons();
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.callback_data).toMatch(BOUND_RE);
    }
    await world.app.close();
  });

  it('(6) simultaneous searches stay isolated with distinct interaction ids', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    const gabrielId = world.interactions.getActive(GROUP_CHAT_ID, GABRIEL)?.id;
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, 'netflix'));
    const edwardId = world.interactions.getActive(GROUP_CHAT_ID, EDWARD)?.id;
    expect(gabrielId).toBeDefined();
    expect(edwardId).toBeDefined();
    expect(gabrielId).not.toBe(edwardId);
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Edward');
    await world.app.close();
  });

  it('(7) Edward tapping Gabriel Ver-cliente button is cross-rejected', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    const gabrielView = world.client.findButton('1️⃣ Ver cliente');
    if (gabrielView === undefined) {
      throw new Error('Gabriel result button missing');
    }
    const before = world.client.messageCount();
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, gabrielView));
    expect(world.client.answers().at(-1)).toMatchObject({
      text: 'Esta acción pertenece a Gabriel.',
    });
    expect(world.client.messageCount()).toBe(before);
    expect(world.interactions.getActive(GROUP_CHAT_ID, EDWARD)).toBeUndefined();
    await world.app.close();
  });

  it('(8) Gabriel tapping his own Ver-cliente button opens the detail', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    const gabrielView = world.client.findButton('1️⃣ Ver cliente');
    if (gabrielView === undefined) {
      throw new Error('Gabriel result button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, gabrielView));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('Anny Tovar');
    expect(last).toContain('👤 Operador: Gabriel');
    await world.app.close();
  });

  it('(9) text input never crosses actors (drafts + searches)', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const gOperar = world.client.findButton('⚡OPERAR');
    if (gOperar === undefined) {
      throw new Error('Gabriel OPERAR button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, gOperar));
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, '/start'));
    const eOperar = world.client.findButton('⚡OPERAR');
    if (eOperar === undefined || eOperar === gOperar) {
      throw new Error('Edward OPERAR button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, eOperar));
    // Edward sends a phone search: it must NOT land in Gabriel's draft
    // nor create Gabriel-owned state.
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, '4145460657'));
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.months).toBe(1);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })?.months).toBe(1);
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Edward');
    // Edward's months correction touches only his draft.
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, 'hazlo 9 meses'));
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })?.months).toBe(9);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.months).toBe(1);
    await world.app.close();
  });

  it('(10) Edward replying to Gabriel interactive message is rejected', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const gabrielHome = world.client.texts().at(-1) ?? '';
    expect(gabrielHome).toContain('👤 Operador: Gabriel');
    const interactionsBefore = world.interactions.snapshot().length;
    await world.post(
      groupMessage(world.nextUpdateId(), EDWARD, 'dale pues', GROUP_CHAT_ID, gabrielHome),
    );
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este requerimiento pertenece a Gabriel.',
    );
    expect(world.interactions.snapshot().length).toBe(interactionsBefore);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })).toBeUndefined();
    await world.app.close();
  });
});

describe('C. Draft isolation (11–20)', () => {
  async function openOwnedDraft(world: OwnerWorld, actor: number): Promise<string> {
    await world.post(groupMessage(world.nextUpdateId(), actor, '/start'));
    const operar = world.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), actor, operar));
    const confirm = world.client.findButton('✅Confirmar');
    if (confirm === undefined) {
      throw new Error('Confirmar button missing');
    }
    return confirm;
  }

  it('(11) Gabriel operar creates an OPERATION interaction + open draft', async () => {
    const world = await createOwnerWorld();
    await openOwnedDraft(world, GABRIEL);
    const active = world.interactions.getActive(GROUP_CHAT_ID, GABRIEL);
    expect(active?.type).toBe('OPERATION');
    expect(active?.ownerTelegramUserId).toBe(GABRIEL);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Gabriel');
    await world.app.close();
  });

  it('(12) Edward operar stays fully separate', async () => {
    const world = await createOwnerWorld();
    await openOwnedDraft(world, GABRIEL);
    await openOwnedDraft(world, EDWARD);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })?.status).toBe('open');
    await world.app.close();
  });

  it('(13) Gabriel corrections touch only draft A', async () => {
    const world = await createOwnerWorld();
    await openOwnedDraft(world, GABRIEL);
    await openOwnedDraft(world, EDWARD);
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'hazlo 3 meses'));
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.months).toBe(3);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })?.months).toBe(1);
    await world.app.close();
  });

  it('(14) Edward corrections touch only draft B', async () => {
    const world = await createOwnerWorld();
    await openOwnedDraft(world, GABRIEL);
    await openOwnedDraft(world, EDWARD);
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, 'hazlo 6 meses'));
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })?.months).toBe(6);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.months).toBe(1);
    await world.app.close();
  });

  it('(15) cross confirm on the owned button is blocked with the toast', async () => {
    const world = await createOwnerWorld();
    const gabrielConfirm = await openOwnedDraft(world, GABRIEL);
    const before = world.client.messageCount();
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, gabrielConfirm));
    expect(world.client.answers().at(-1)).toMatchObject({
      text: 'Esta acción pertenece a Gabriel.',
    });
    expect(world.client.messageCount()).toBe(before);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    await world.app.close();
  });

  it('(16) cross cancel on the owned button is blocked', async () => {
    const world = await createOwnerWorld();
    await openOwnedDraft(world, GABRIEL);
    const gabrielCancel = world.client.findButton('❌Cancelar');
    if (gabrielCancel === undefined) {
      throw new Error('Cancelar button missing');
    }
    const before = world.client.messageCount();
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, gabrielCancel));
    expect(world.client.answers().at(-1)).toMatchObject({
      text: 'Esta acción pertenece a Gabriel.',
    });
    expect(world.client.messageCount()).toBe(before);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    await world.app.close();
  });

  it('(17) cross Corregir on the owned button is blocked', async () => {
    const world = await createOwnerWorld();
    await openOwnedDraft(world, GABRIEL);
    const gabrielCorrect = world.client.findButton('✏️Corregir');
    if (gabrielCorrect === undefined) {
      throw new Error('Corregir button missing');
    }
    const before = world.client.messageCount();
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, gabrielCorrect));
    expect(world.client.answers().at(-1)).toMatchObject({
      text: 'Esta acción pertenece a Gabriel.',
    });
    expect(world.client.messageCount()).toBe(before);
    await world.app.close();
  });

  it('(18) own confirm executes and closes the interaction', async () => {
    const world = await createOwnerWorld();
    const gabrielConfirm = await openOwnedDraft(world, GABRIEL);
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, gabrielConfirm));
    expect(world.client.texts().at(-1)).toContain('✅ Operación MOCK confirmada');
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe(
      'confirmed',
    );
    await world.app.close();
  });

  it('(19) own cancel executes idempotently setup (PENDING→CANCELLED)', async () => {
    const world = await createOwnerWorld();
    await openOwnedDraft(world, GABRIEL);
    const gabrielCancel = world.client.findButton('❌Cancelar');
    if (gabrielCancel === undefined) {
      throw new Error('Cancelar button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, gabrielCancel));
    expect(world.client.texts().at(-1)).toContain('❌ Operación cancelada');
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe(
      'cancelled',
    );
    await world.app.close();
  });

  it('(20) cancel repeats answer already-cancelled with no loop or recreation', async () => {
    const world = await createOwnerWorld();
    await openOwnedDraft(world, GABRIEL);
    const gabrielCancel = world.client.findButton('❌Cancelar');
    if (gabrielCancel === undefined) {
      throw new Error('Cancelar button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, gabrielCancel));
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, gabrielCancel));
    expect(world.client.texts().at(-1)).toContain(CANCELLED_TEXT);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe(
      'cancelled',
    );
    // No recreation: still no open draft for Gabriel.
    expect(world.drafts.isOpen({ chatId: GROUP_CHAT_ID, userId: GABRIEL })).toBe(false);
    await world.app.close();
  });
});

describe('D. Navigation ownership (21–23)', () => {
  it('(21) cross-actor Volver is rejected and mutates nothing', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    const volver = world.client.findButton('←Volver');
    if (volver === undefined) {
      throw new Error('Volver button missing');
    }
    const gabrielActive = world.interactions.getActive(GROUP_CHAT_ID, GABRIEL)?.id;
    const before = world.client.messageCount();
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, volver));
    expect(world.client.answers().at(-1)).toMatchObject({
      text: 'Esta acción pertenece a Gabriel.',
    });
    expect(world.client.messageCount()).toBe(before);
    expect(world.interactions.getActive(GROUP_CHAT_ID, GABRIEL)?.id).toBe(gabrielActive);
    await world.app.close();
  });

  it('(22) own Volver returns Home with the right label', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    const volver = world.client.findButton('←Volver');
    if (volver === undefined) {
      throw new Error('Volver button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, volver));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain(HOME_TEXT);
    expect(last).toContain('👤 Operador: Gabriel');
    await world.app.close();
  });

  it('(23) Volver never deletes drafts or persistent requirements', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const operar = world.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, operar));
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'hazlo 3 meses'));
    const volver = world.client.findButton('←Volver');
    if (volver === undefined) {
      throw new Error('Volver button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, volver));
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.months).toBe(3);
    await world.app.close();
  });
});

describe('E. Callback resolution (24–28)', () => {
  it('(24) owned callbacks resolve interaction → chat → owner → state', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const operar = world.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    expect(operar).toMatch(BOUND_RE);
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, operar));
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe('open');
    await world.app.close();
  });

  it('(25) stale callbacks (unknown interactionId) are a safe no-op', async () => {
    const world = await createOwnerWorld();
    const before = world.client.messageCount();
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, 'v1:ok:deadbeef'));
    expect(world.client.answers().length).toBe(1);
    expect(world.client.answers()[0]?.text).toBeUndefined();
    expect(world.client.messageCount()).toBe(before);
    expect(world.interactions.snapshot()).toEqual([]);
    expect(
      world.auditEvents.some((event) => event.actionType === 'interaction.stale_callback'),
    ).toBe(true);
    await world.app.close();
  });

  it('(26) repeats are idempotent with no loop or extra mutation', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const operar = world.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, operar));
    const cancel = world.client.findButton('❌Cancelar');
    if (cancel === undefined) {
      throw new Error('Cancelar button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, cancel));
    const countAfterFirst = world.client.messageCount();
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, cancel));
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, cancel));
    expect(world.client.texts().at(-1)).toContain(CANCELLED_TEXT);
    expect(world.client.messageCount()).toBe(countAfterFirst + 2);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe(
      'cancelled',
    );
    await world.app.close();
  });

  it('(27) wrong-owner taps never edit, mutate, or navigate', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'netflix'));
    const next = world.client.findButton('Siguiente→');
    const target = next ?? world.client.findButton('←Volver');
    if (target === undefined) {
      throw new Error('owned nav button missing');
    }
    const before = world.client.messageCount();
    const snapshotBefore = JSON.stringify(world.interactions.snapshot());
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, target));
    expect(world.client.answers().at(-1)?.text).toBe('Esta acción pertenece a Gabriel.');
    expect(world.client.messageCount()).toBe(before);
    expect(JSON.stringify(world.interactions.snapshot())).toBe(snapshotBefore);
    await world.app.close();
  });

  it('(28) wrong-chat taps are rejected when a chat restriction is configured', async () => {
    const world = await createOwnerWorld(
      undefined,
      `${GROUP_CHAT_ID},${FOREIGN_CHAT_ID}`,
    );
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const operar = world.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    const before = world.client.messageCount();
    // Same owner, but the tap arrives from a different chat than the interaction's.
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, operar, FOREIGN_CHAT_ID));
    expect(world.client.answers().at(-1)?.text).toBe('Esta acción pertenece a Gabriel.');
    expect(world.client.messageCount()).toBe(before);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })).toBeUndefined();
    expect(world.drafts.get({ chatId: FOREIGN_CHAT_ID, userId: GABRIEL })).toBeUndefined();
    await world.app.close();
  });
});

describe('F. Concurrency isolation (29–32)', () => {
  it('(29) near-simultaneous interleaved updates stay isolated per actor', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const gOperar = world.client.findButton('⚡OPERAR');
    if (gOperar === undefined) {
      throw new Error('OPERAR button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, gOperar));
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, '/start'));
    const eOperar = world.client.findButton('⚡OPERAR');
    if (eOperar === undefined) {
      throw new Error('OPERAR button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, eOperar));
    // Interleaved corrections + searches, alternating actors.
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'hazlo 3 meses'));
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, 'netflix'));
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, 'hazlo 5 meses'));
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'hazlo 4 meses'));
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, 'cmaxnet001'));
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.months).toBe(4);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })?.months).toBe(5);
    // Interaction state survives a file round-trip (redeploy-safe).
    const filePath = join(mkdtempSync(join(tmpdir(), 'vokath-int-')), 'interactions.json');
    await world.interactions.saveToFile(filePath);
    const revived = new InteractionStore();
    await revived.loadFromFile(filePath);
    expect(revived.getActive(GROUP_CHAT_ID, GABRIEL)?.ownerTelegramUserId).toBe(GABRIEL);
    expect(revived.getActive(GROUP_CHAT_ID, EDWARD)?.ownerTelegramUserId).toBe(EDWARD);
    await world.app.close();
  });

  it('(30) audit records the correct actor across interleaved updates', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, '/start'));
    const created = world.auditEvents.filter(
      (event) => event.actionType === 'interaction.created',
    );
    expect(created.length).toBe(2);
    expect(created.map((event) => event.actorTelegramUserId).sort()).toEqual(
      [EDWARD, GABRIEL].sort(),
    );
    for (const event of created) {
      expect(event.chatId).toBe(GROUP_CHAT_ID);
    }
    await world.app.close();
  });

  it('(31) no chatId-only state exists anywhere in the live stores', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, '/start'));
    // Sessions are keyed (chatId, userId): distinct keys, same chat.
    const gSession = world.sessions.getSession(GABRIEL, GROUP_CHAT_ID);
    const eSession = world.sessions.getSession(EDWARD, GROUP_CHAT_ID);
    expect(gSession?.userId).toBe(GABRIEL);
    expect(eSession?.userId).toBe(EDWARD);
    expect(SessionStore.sessionKey(GROUP_CHAT_ID, GABRIEL)).not.toBe(
      SessionStore.sessionKey(GROUP_CHAT_ID, EDWARD),
    );
    // getActive never crosses actors: each actor sees only their own.
    expect(world.interactions.getActive(GROUP_CHAT_ID, GABRIEL)?.ownerTelegramUserId).toBe(
      GABRIEL,
    );
    expect(world.interactions.getActive(GROUP_CHAT_ID, EDWARD)?.ownerTelegramUserId).toBe(
      EDWARD,
    );
    // Every stored interaction carries the full minimal scope.
    for (const interaction of world.interactions.snapshot()) {
      expect(typeof interaction.id).toBe('string');
      expect(interaction.chatId).toBe(GROUP_CHAT_ID);
      expect([GABRIEL, EDWARD]).toContain(interaction.ownerTelegramUserId);
    }
    // Drafts resolve per (chatId, actor) — Gabriel's key never reads Edward's.
    expect(
      world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL }),
    ).toBeUndefined();
    await world.app.close();
  });

  it('(32) interleaved owned cancels affect only their own drafts', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const gOperar = world.client.findButton('⚡OPERAR');
    if (gOperar === undefined) {
      throw new Error('Gabriel OPERAR button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, gOperar));
    const gCancel = world.client.findButton('❌Cancelar');
    if (gCancel === undefined) {
      throw new Error('Gabriel Cancelar button missing');
    }
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, '/start'));
    const eOperar = world.client.findButton('⚡OPERAR');
    if (eOperar === undefined) {
      throw new Error('Edward OPERAR button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, eOperar));
    const eCancel = world.client.findButton('❌Cancelar');
    if (eCancel === undefined || eCancel === gCancel) {
      throw new Error('Edward Cancelar button missing');
    }
    // Interleaved: Edward cancels his own, then Gabriel cancels his own.
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, eCancel));
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, gCancel));
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD })?.status).toBe(
      'cancelled',
    );
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })?.status).toBe(
      'cancelled',
    );
    // And a cross attempt changes nothing: Gabriel's (already terminal)
    // button tapped by Edward stays a pure rejection.
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, gCancel));
    expect(world.client.answers().at(-1)?.text).toBe('Esta acción pertenece a Gabriel.');
    await world.app.close();
  });
});

describe('G. Gemini per-actor context (33–34)', () => {
  it('(33) the interpreter receives only the sender actor identity', async () => {
    const recorder = new RecordingInterpreter();
    const world = await createOwnerWorld(recorder);
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'quiero buscar un cliente'));
    expect(recorder.calls).toBe(1);
    expect(recorder.contexts).toEqual([
      { userId: GABRIEL, chatId: GROUP_CHAT_ID, ownerName: 'Gabriel' },
    ]);
    await world.app.close();
  });

  it('(34) peer drafts/searches never leak into the Gemini context', async () => {
    const recorder = new RecordingInterpreter();
    const world = await createOwnerWorld(recorder);
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, '/start'));
    const operar = world.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, operar));
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, 'hazlo 7 meses'));
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, '4145460657'));
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'quiero buscar un cliente'));
    const last = recorder.contexts.at(-1);
    expect(last).toEqual({ userId: GABRIEL, chatId: GROUP_CHAT_ID, ownerName: 'Gabriel' });
    expect(JSON.stringify(last)).not.toContain(String(EDWARD));
    expect(JSON.stringify(last)).not.toContain('7 meses');
    await world.app.close();
  });
});

describe('H. FlujoTV account identifiers (35–39)', () => {
  it('(35) a real Netflix email from the fixture is recognized (zero Gemini)', async () => {
    const world = await createOwnerWorld();
    await world.post(
      groupMessage(world.nextUpdateId(), GABRIEL, 'dasdsadasda@gmail.com'),
    );
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    await world.app.close();
  });

  it('(36) a real FlujoTV username without @ is recognized (zero Gemini)', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    expect(world.interpreter.calls).toBe(0);
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('resultado(s) MOCK');
    expect(last).toContain('Anny Tovar');
    await world.app.close();
  });

  it('(37) a real FlujoTV phone is recognized (zero Gemini)', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, '4145460657'));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('Anny Tovar');
    await world.app.close();
  });

  it('(38) email is never assumed to be Netflix — servicio comes from the data', async () => {
    expect(parseFast('cmaxnet001')).toEqual({ kind: 'account', value: 'cmaxnet001' });
    expect(parseFast('dasdsadasda@gmail.com')).toMatchObject({ kind: 'email' });
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'cmaxnet001'));
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toContain('resultado(s) MOCK');
    // Plain words still fall through to L3 — the account guard is tight.
    expect(parseFast('quiero buscar un cliente')).toEqual({ kind: 'none' });
    expect(parseFast('buscar')).toEqual({ kind: 'none' });
    await world.app.close();
  });

  it('(39) another real FlujoTV account routes L2 with zero Gemini', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, 'maxnet001'));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    await world.app.close();
  });
});

describe('I. Operator UX label (40–42)', () => {
  it('(40) Home shows the acting operator label', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Gabriel');
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, '/start'));
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Edward');
    await world.app.close();
  });

  it('(41) draft and search messages show their owner label', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const operar = world.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, operar));
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Gabriel');
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, 'cmaxnet001'));
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Edward');
    await world.app.close();
  });

  it('(42) cross-actor rejection emits no labeled state change', async () => {
    const world = await createOwnerWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const operar = world.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, operar));
    const gabrielLast = world.client.texts().at(-1);
    const before = world.client.messageCount();
    const confirm = world.client.findButton('✅Confirmar');
    if (confirm === undefined) {
      throw new Error('Confirmar button missing');
    }
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, confirm));
    expect(world.client.messageCount()).toBe(before);
    expect(world.client.texts().at(-1)).toBe(gabrielLast);
    expect(world.client.answers().at(-1)?.text).toBe('Esta acción pertenece a Gabriel.');
    await world.app.close();
  });
});

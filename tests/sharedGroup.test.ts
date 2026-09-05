import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { StubIntentInterpreter } from '../src/ai/intentInterpreter';
import { createAuditor, type AuditEvent } from '../src/audit/audit';
import { parseAuthorizedChatIds, parseAuthorizedIds } from '../src/auth/allowlist';
import { buildApp } from '../src/app';
import type { Env } from '../src/config/env';
import { DraftEngine } from '../src/drafts/engine';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';
import { HOME_TEXT, callbackData } from '../src/telegram/keyboards';
import { UNAUTHORIZED_TEXT } from '../src/telegram/webhook';

/**
 * Shared-group integration: ONE private group, two operators.
 *
 * Identity rule under test: `chat.id` is the shared visible context,
 * `from.id` is the operator identity. Every update below rides the same
 * GROUP_CHAT_ID with a different `from.id` — no private-chat assumptions.
 *
 * Actor/chat ids here are TEST-ONLY values. Business logic never hardcodes
 * them; production reads AUTHORIZED_TELEGRAM_USER_IDS / CHAT_IDS from env.
 */
const GABRIEL = 1057242322;
const EDWARD = 941030473;
const STRANGER = 999999999;
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
};

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

  sends(): Array<{ chatId: number; text: string }> {
    return this.sent
      .filter((entry) => entry.kind === 'send' || entry.kind === 'edit')
      .map((entry) => entry.payload as { chatId: number; text: string });
  }

  texts(): string[] {
    return this.sends().map((entry) => entry.text);
  }

  lastPayloadJson(): string {
    const last = [...this.sent]
      .reverse()
      .find((entry) => entry.kind === 'send' || entry.kind === 'edit');
    return JSON.stringify(last?.payload ?? {});
  }
}

interface GroupWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter;
  sessions: SessionStore;
  drafts: DraftEngine;
  auditEvents: AuditEvent[];
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

async function createGroupWorld(): Promise<GroupWorld> {
  const statePath = join(mkdtempSync(join(tmpdir(), 'vokath-group-')), 'mock-state.json');
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath,
  });
  const client = new StubTelegramClient();
  const interpreter = new StubIntentInterpreter();
  const sessions = new SessionStore();
  const drafts = new DraftEngine();
  const auditEvents: AuditEvent[] = [];
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions,
    drafts,
    interpreter,
    repos: new MockAccountRepositories(store),
    client,
    auditor: createAuditor((event) => {
      auditEvents.push(event);
    }),
  });
  let counter = 5000;
  return {
    app,
    client,
    interpreter,
    sessions,
    drafts,
    auditEvents,
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

const NAMES: Record<number, string> = { [GABRIEL]: 'Gabriel', [EDWARD]: 'Edward' };

function groupMessage(
  updateId: number,
  actorId: number,
  text: string,
  chatId: number = GROUP_CHAT_ID,
): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Stranger' },
      chat: { id: chatId, type: 'supergroup' },
      text,
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

function gabrielDraft(world: GroupWorld) {
  return world.drafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL });
}

function edwardDraft(world: GroupWorld) {
  return world.drafts.get({ chatId: GROUP_CHAT_ID, userId: EDWARD });
}

describe('shared group operation (chat.id = context, from.id = operator)', () => {
  it('(1) a Gabriel message identifies Gabriel as the actor', async () => {
    const world = await createGroupWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    const session = world.sessions.getSession(GABRIEL, GROUP_CHAT_ID);
    expect(session?.userId).toBe(GABRIEL);
    expect(session?.chatId).toBe(GROUP_CHAT_ID);
    await world.app.close();
  });

  it('(2) an Edward message identifies Edward as the actor', async () => {
    const world = await createGroupWorld();
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, '/start'));
    const session = world.sessions.getSession(EDWARD, GROUP_CHAT_ID);
    expect(session?.userId).toBe(EDWARD);
    expect(session?.chatId).toBe(GROUP_CHAT_ID);
    await world.app.close();
  });

  it('(3) both operators share the same chatId — replies land in the group', async () => {
    const world = await createGroupWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start'));
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, '/start'));
    expect(world.sessions.getSession(GABRIEL, GROUP_CHAT_ID)?.chatId).toBe(GROUP_CHAT_ID);
    expect(world.sessions.getSession(EDWARD, GROUP_CHAT_ID)?.chatId).toBe(GROUP_CHAT_ID);
    for (const send of world.client.sends()) {
      expect(send.chatId).toBe(GROUP_CHAT_ID);
    }
    await world.app.close();
  });

  it('(4) search works for Gabriel (phone, zero Gemini)', async () => {
    const world = await createGroupWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '4145460657'));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('Anny Tovar');
    await world.app.close();
  });

  it('(5) search works for Edward (service name, zero Gemini)', async () => {
    const world = await createGroupWorld();
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, 'netflix'));
    expect(world.interpreter.calls).toBe(0);
    expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    await world.app.close();
  });

  it('(6) Gabriel opens draft A in the shared group', async () => {
    const world = await createGroupWorld();
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('operar')));
    expect(gabrielDraft(world)?.status).toBe('open');
    expect(world.client.texts().at(-1)).toContain('Borrador MOCK abierto');
    await world.app.close();
  });

  it('(7) Edward opens draft B in the shared group', async () => {
    const world = await createGroupWorld();
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, callbackData('operar')));
    expect(edwardDraft(world)?.status).toBe('open');
    await world.app.close();
  });

  it('(8) drafts A and B stay fully separate', async () => {
    const world = await createGroupWorld();
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('operar')));
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, callbackData('operar')));
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'hazlo 3 meses'));
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, 'hazlo 5 meses'));
    expect(gabrielDraft(world)?.months).toBe(3);
    expect(edwardDraft(world)?.months).toBe(5);
    await world.app.close();
  });

  it('(9) Gabriel corrections touch only draft A', async () => {
    const world = await createGroupWorld();
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('operar')));
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, callbackData('operar')));
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'hazlo 3 meses'));
    expect(world.client.texts().at(-1)).toContain('Borrador actualizado: 3 mes(es)');
    expect(gabrielDraft(world)?.months).toBe(3);
    expect(edwardDraft(world)?.months).toBe(1);
    await world.app.close();
  });

  it('(10) Edward corrections touch only draft B', async () => {
    const world = await createGroupWorld();
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('operar')));
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, callbackData('operar')));
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, 'hazlo 6 meses'));
    expect(edwardDraft(world)?.months).toBe(6);
    expect(gabrielDraft(world)?.months).toBe(1);
    await world.app.close();
  });

  it('(11) Edward Confirm on Gabriel draft is blocked with the ownership text', async () => {
    const world = await createGroupWorld();
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('operar')));
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, callbackData('confirm')));
    expect(world.client.texts().at(-1)).toBe('⚠️ Esta operación pertenece a Gabriel.');
    expect(gabrielDraft(world)?.status).toBe('open');
    expect(edwardDraft(world)).toBeUndefined();
    await world.app.close();
  });

  it('(12) Gabriel Cancel on Edward draft is blocked with the ownership text', async () => {
    const world = await createGroupWorld();
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, callbackData('operar')));
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('cancel')));
    expect(world.client.texts().at(-1)).toBe('⚠️ Esta operación pertenece a Edward.');
    expect(edwardDraft(world)?.status).toBe('open');
    expect(gabrielDraft(world)).toBeUndefined();
    await world.app.close();
  });

  it('(13) navigation never wipes either draft', async () => {
    const world = await createGroupWorld();
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('operar')));
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'hazlo 3 meses'));
    const nav: string[] = ['buscar', 'vencidos', 'inventario', 'caja', 'mas', 'back'].map((a) =>
      callbackData(a as 'buscar'),
    );
    for (const data of nav) {
      await world.post(groupCallback(world.nextUpdateId(), GABRIEL, data));
    }
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, 'volver'));
    expect(gabrielDraft(world)?.status).toBe('open');
    expect(gabrielDraft(world)?.months).toBe(3);
    expect(world.client.texts().at(-1)).toBe(HOME_TEXT);
    await world.app.close();
  });

  it('(14) a new operation resumes the same actor draft', async () => {
    const world = await createGroupWorld();
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('operar')));
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'hazlo 4 meses'));
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('operar')));
    expect(world.client.texts().at(-1)).toContain('Borrador retomado: 4 mes(es)');
    expect(gabrielDraft(world)?.months).toBe(4);
    await world.app.close();
  });

  it('(15) unauthorized chat is rejected with zero side-effects', async () => {
    const world = await createGroupWorld();
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, '/start', FOREIGN_CHAT_ID));
    expect(world.client.texts()).toEqual([UNAUTHORIZED_TEXT]);
    expect(world.interpreter.calls).toBe(0);
    expect(world.sessions.getSession(GABRIEL, FOREIGN_CHAT_ID)).toBeUndefined();
    expect(world.drafts.get({ chatId: FOREIGN_CHAT_ID, userId: GABRIEL })).toBeUndefined();
    expect(
      world.auditEvents.some((event) => event.actionType === 'auth.rejected_chat'),
    ).toBe(true);
    await world.app.close();
  });

  it('(16) unauthorized user inside the group is rejected with zero side-effects', async () => {
    const world = await createGroupWorld();
    await world.post(groupMessage(world.nextUpdateId(), STRANGER, '/start'));
    expect(world.client.texts()).toEqual([UNAUTHORIZED_TEXT]);
    expect(world.interpreter.calls).toBe(0);
    expect(world.sessions.getSession(STRANGER, GROUP_CHAT_ID)).toBeUndefined();
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: STRANGER })).toBeUndefined();
    expect(
      world.auditEvents.some((event) => event.actionType === 'auth.rejected_user'),
    ).toBe(true);
    await world.app.close();
  });

  it('(17) callbacks validate chatId + from.id', async () => {
    const world = await createGroupWorld();
    // Gabriel taps OPERAR from a foreign chat → rejected, no draft anywhere.
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('operar'), FOREIGN_CHAT_ID));
    expect(world.client.texts()).toEqual([UNAUTHORIZED_TEXT]);
    expect(gabrielDraft(world)).toBeUndefined();
    // Stranger taps inside the group → rejected, zero Gemini.
    await world.post(groupCallback(world.nextUpdateId(), STRANGER, callbackData('buscar')));
    expect(world.client.texts().at(-1)).toBe(UNAUTHORIZED_TEXT);
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });

  it('(18) audit records the correct actor per action', async () => {
    const world = await createGroupWorld();
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('operar')));
    await world.post(groupCallback(world.nextUpdateId(), EDWARD, callbackData('operar')));
    await world.post(groupMessage(world.nextUpdateId(), EDWARD, 'hazlo 2 meses'));
    const created = world.auditEvents.filter((event) => event.actionType === 'draft.created');
    expect(created.map((event) => event.actorTelegramUserId).sort()).toEqual(
      [EDWARD, GABRIEL].sort(),
    );
    for (const event of created) {
      expect(event.chatId).toBe(GROUP_CHAT_ID);
      expect(event.entity).toBe(`draft:${GROUP_CHAT_ID}:${event.actorTelegramUserId}`);
    }
    const updated = world.auditEvents.filter((event) => event.actionType === 'draft.updated');
    expect(updated.length).toBe(1);
    expect(updated[0]?.actorTelegramUserId).toBe(EDWARD);
    expect(JSON.stringify(world.auditEvents)).not.toContain('contrasena');
    await world.app.close();
  });
});

describe('shared group Fase 1 fixes (cancel loop, volver, FlujoTV)', () => {
  it('cancel lands on Home — no draft buttons, no loop', async () => {
    const world = await createGroupWorld();
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('operar')));
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('cancel')));
    expect(world.client.texts().at(-1)).toBe('❌ Operación cancelada');
    const afterCancel = world.client.lastPayloadJson();
    expect(afterCancel).toContain('OPERAR');
    expect(afterCancel).not.toContain('Confirmar');
    expect(afterCancel).not.toContain('Cancelar');
    // Tapping cancel again is a dead end on Home, never a loop.
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'cancelar'));
    expect(world.client.texts().at(-1)).toBe('Sin borrador abierto que cancelar.');
    expect(world.client.lastPayloadJson()).toContain('OPERAR');
    await world.app.close();
  });

  it('Volver from the draft keyboard returns Home without touching the draft', async () => {
    const world = await createGroupWorld();
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('operar')));
    await world.post(groupMessage(world.nextUpdateId(), GABRIEL, 'hazlo 2 meses'));
    await world.post(groupCallback(world.nextUpdateId(), GABRIEL, callbackData('back')));
    expect(world.client.texts().at(-1)).toBe(HOME_TEXT);
    expect(gabrielDraft(world)?.status).toBe('open');
    expect(gabrielDraft(world)?.months).toBe(2);
    await world.app.close();
  });

  it('FlujoTV recognition works end-to-end in the group (zero Gemini)', async () => {
    const world = await createGroupWorld();
    for (const text of ['FlujoTV', 'flujo tv']) {
      await world.post(groupMessage(world.nextUpdateId(), GABRIEL, text));
      expect(world.client.texts().at(-1)).toContain('resultado(s) MOCK');
    }
    expect(world.interpreter.calls).toBe(0);
    await world.app.close();
  });
});

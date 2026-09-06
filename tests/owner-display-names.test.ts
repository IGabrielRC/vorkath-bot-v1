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
import type { ChatMember, TelegramClient } from '../src/telegram/client';
import { callbackData } from '../src/telegram/keyboards';

/**
 * Owner display-name resolution suite (cross-topic id-leak fix).
 *
 * Production bug: the cross-topic guard resolved the TOPIC OWNER's name
 * with only a numeric id and no `from` fields (the owner may never have
 * interacted), so the fallback chain ended at an id-based string
 * (`Usuario <id>`) inside `⚠️ Este espacio pertenece a …`.
 *
 * Rule under test: every rejection/ownership message naming ANOTHER
 * operator resolves via the OperatorProfile store first; a missing
 * profile falls back to getChatMember (last resort, then persisted);
 * the final chain is first+last → first → @username → bare `Usuario`
 * (never empty, never a numeric id — ids survive only in /topicid
 * diagnostics). Security stays id-keyed throughout.
 *
 * Actor ids here are TEST-ONLY values. Business logic never hardcodes
 * them. No seeded names anywhere: profiles must come from live `from`
 * fields or the member fetcher, exactly like production.
 */
const GABRIEL = 1057242322;
const EDWARD = 941030473;
const ANDRES = 555666777;
const STRANGER = 777888999;
const GROUP_CHAT_ID = -1005550001;

const T_GABRIEL = 18;
const T_EDWARD = 19;
const T_ANDRES = 24;

const SECRET = 'owner-names-test-secret-long-enough';

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  TELEGRAM_BOT_TOKEN: 'tok-test-secret',
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  AUTHORIZED_TELEGRAM_USER_IDS: `${GABRIEL},${EDWARD},${ANDRES},${STRANGER}`,
  AUTHORIZED_TELEGRAM_CHAT_IDS: `${GROUP_CHAT_ID}`,
  TELEGRAM_OPERATOR_TOPICS: '',
  TELEGRAM_ACTIVITY_TOPIC_ID: '',
  GEMINI_API_KEY: 'key-test-secret',
  GEMINI_MODEL: 'gemini-2.0-flash',
  PUBLIC_BASE_URL: 'https://example.com',
  REGISTER_TELEGRAM_WEBHOOK: 'false',
  MOCK_STATE_PATH: '/data/mock-state.json',
  DRAFTS_STATE_PATH: '/data/drafts-state.json',
  INTERACTIONS_STATE_PATH: '/data/interactions-state.json',
};

interface SentPayload {
  chatId: number;
  text: string;
  replyMarkup?: unknown;
  messageThreadId?: number;
}

/** Base stub WITHOUT getChatMember: proves offline doubles still work. */
class StubTelegramClient implements TelegramClient {
  readonly sent: Array<{ kind: 'send' | 'edit' | 'answer'; payload: unknown }> = [];

  async sendMessage(opts: SentPayload): Promise<unknown> {
    this.sent.push({ kind: 'send', payload: opts });
    return { ok: true };
  }

  async editMessageText(opts: SentPayload & { messageId: number }): Promise<unknown> {
    this.sent.push({ kind: 'edit', payload: opts });
    return { ok: true };
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    opts?: { text?: string },
  ): Promise<unknown> {
    this.sent.push({
      kind: 'answer',
      payload: { callbackQueryId, ...(opts?.text !== undefined ? { text: opts.text } : {}) },
    });
    return { ok: true };
  }

  sends(): SentPayload[] {
    return this.sent
      .filter((entry) => entry.kind === 'send' || entry.kind === 'edit')
      .map((entry) => entry.payload as SentPayload);
  }

  texts(): string[] {
    return this.sends().map((entry) => entry.text);
  }

  answers(): Array<{ callbackQueryId: string; text?: string }> {
    return this.sent
      .filter((entry) => entry.kind === 'answer')
      .map((entry) => entry.payload as { callbackQueryId: string; text?: string });
  }

  findButton(text: string): string | undefined {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      const entry = this.sent[index];
      if (entry === undefined || entry.kind === 'answer') {
        continue;
      }
      const payload = entry.payload as SentPayload & {
        replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      };
      const flat = payload.replyMarkup?.inline_keyboard.flat() ?? [];
      const found = flat.find((button) => button.text === text);
      if (found !== undefined) {
        return found.callback_data;
      }
    }
    return undefined;
  }
}

/** Stub WITH optional getChatMember: counts member lookups. */
class MemberStubClient extends StubTelegramClient {
  memberCalls: Array<{ chatId: number; userId: number }> = [];
  members = new Map<number, ChatMember>();
  failMembers = false;

  async getChatMember(chatId: number, userId: number): Promise<ChatMember | undefined> {
    this.memberCalls.push({ chatId, userId });
    if (this.failMembers) {
      throw new Error('chat member lookup failed');
    }
    return this.members.get(userId);
  }
}

interface OwnerWorld {
  app: FastifyInstance;
  client: StubTelegramClient;
  interpreter: StubIntentInterpreter;
  sessions: SessionStore;
  drafts: DraftEngine;
  interactions: InteractionStore;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<{ status: number; body: unknown }>;
}

const MODE_B_TOPICS = new Map<number, number>([
  [GABRIEL, T_GABRIEL],
  [EDWARD, T_EDWARD],
  [ANDRES, T_ANDRES],
]);

async function createOwnerWorld(opts?: {
  bareClient?: boolean;
  members?: Map<number, ChatMember>;
}): Promise<OwnerWorld> {
  const statePath = join(mkdtempSync(join(tmpdir(), 'vokath-owner-')), 'mock-state.json');
  const store = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath,
  });
  const bare = new StubTelegramClient();
  const full = new MemberStubClient();
  const client: StubTelegramClient = opts?.bareClient === true ? bare : full;
  if (opts?.members !== undefined) {
    full.members = opts.members;
  }
  const interpreter = new StubIntentInterpreter();
  const sessions = new SessionStore();
  const drafts = new DraftEngine();
  const interactions = new InteractionStore();
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions,
    drafts,
    interactions,
    interpreter,
    repos: new MockAccountRepositories(store),
    client,
    auditor: createAuditor(),
    operatorTopics: MODE_B_TOPICS,
  });
  let counter = 9000;
  return {
    app,
    client,
    interpreter,
    sessions,
    drafts,
    interactions,
    nextUpdateId: () => {
      counter += 1;
      return counter;
    },
    post: async (update: unknown) => {
      const response = await app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': SECRET },
        payload: update,
      });
      return { status: response.statusCode, body: response.json() as unknown };
    },
  };
}

function ownerMessage(
  updateId: number,
  actorId: number,
  text: string,
  threadId?: number,
  fromExtra?: Record<string, string>,
): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      from: { id: actorId, ...fromExtra },
      chat: { id: GROUP_CHAT_ID, type: 'supergroup', is_forum: true },
      text,
    },
  };
}

const RAW_IDS = [GABRIEL, EDWARD, ANDRES, STRANGER].map(String);

function expectNoRawIds(text: string): void {
  for (const id of RAW_IDS) {
    expect(text).not.toContain(id);
  }
}

describe('owner display names (cross-topic id-leak fix)', () => {
  it('1. Edward interacts → profile stored', async () => {
    const world = await createOwnerWorld();
    expect(world.interactions.getOperatorProfile(EDWARD)).toBeUndefined();
    await world.post(
      ownerMessage(world.nextUpdateId(), EDWARD, '/start', T_EDWARD, {
        first_name: 'Edward',
      }),
    );
    const profile = world.interactions.getOperatorProfile(EDWARD);
    expect(profile?.telegramUserId).toBe(EDWARD);
    expect(profile?.displayName).toBe('Edward');
    await world.app.close();
  });

  it('2. Gabriel enters Edward topic → names Edward, never the id', async () => {
    const world = await createOwnerWorld();
    await world.post(
      ownerMessage(world.nextUpdateId(), EDWARD, '/start', T_EDWARD, {
        first_name: 'Edward',
      }),
    );
    await world.post(
      ownerMessage(world.nextUpdateId(), GABRIEL, '/start', T_EDWARD, {
        first_name: 'Gabriel',
      }),
    );
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toBe('⚠️ Este espacio pertenece a Edward. Usa tu topic 👤 Gabriel.');
    expectNoRawIds(last);
    // Store hit: no member lookup fired for a known owner.
    expect((world.client as MemberStubClient).memberCalls).toHaveLength(0);
    await world.app.close();
  });

  it('3. Andres interacts → stored', async () => {
    const world = await createOwnerWorld();
    expect(world.interactions.getOperatorProfile(ANDRES)).toBeUndefined();
    await world.post(
      ownerMessage(world.nextUpdateId(), ANDRES, '/start', T_ANDRES, {
        first_name: 'Andres',
      }),
    );
    expect(world.interactions.getOperatorProfile(ANDRES)?.displayName).toBe('Andres');
    await world.app.close();
  });

  it('4. Gabriel enters Andres topic → names Andres', async () => {
    const world = await createOwnerWorld();
    await world.post(
      ownerMessage(world.nextUpdateId(), ANDRES, '/start', T_ANDRES, {
        first_name: 'Andres',
      }),
    );
    await world.post(
      ownerMessage(world.nextUpdateId(), GABRIEL, '/start', T_ANDRES, {
        first_name: 'Gabriel',
      }),
    );
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toBe('⚠️ Este espacio pertenece a Andres. Usa tu topic 👤 Gabriel.');
    expectNoRawIds(last);
    await world.app.close();
  });

  it('5. ownership stays id-based across renames (rename never transfers)', async () => {
    const world = await createOwnerWorld();
    await world.post(
      ownerMessage(world.nextUpdateId(), EDWARD, '/start', T_EDWARD, {
        first_name: 'Edward',
      }),
    );
    // Telegram rename mid-life: profile refreshes, topic ownership does not move.
    await world.post(
      ownerMessage(world.nextUpdateId(), EDWARD, '/start', T_EDWARD, {
        first_name: 'Eddy',
      }),
    );
    expect(world.interactions.getOperatorProfile(EDWARD)?.displayName).toBe('Eddy');
    // Gabriel is still blocked from Edward's topic (id-keyed), now naming Eddy.
    await world.post(
      ownerMessage(world.nextUpdateId(), GABRIEL, '/start', T_EDWARD, {
        first_name: 'Gabriel',
      }),
    );
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toBe('⚠️ Este espacio pertenece a Eddy. Usa tu topic 👤 Gabriel.');
    expectNoRawIds(last);
    // Edward still operates in his own topic after the rename.
    await world.post(
      ownerMessage(world.nextUpdateId(), EDWARD, '/start', T_EDWARD, {
        first_name: 'Eddy',
      }),
    );
    expect(world.client.texts().at(-1)).toContain('👤 Operador: Eddy');
    await world.app.close();
  });

  it('6. same-name stranger cannot steal ownership or labels', async () => {
    const world = await createOwnerWorld();
    await world.post(
      ownerMessage(world.nextUpdateId(), GABRIEL, '/start', T_GABRIEL, {
        first_name: 'Gabriel',
      }),
    );
    const operar = world.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    // Stranger shares no name yet: button tap dies on the id comparison.
    await world.post({
      update_id: world.nextUpdateId(),
      callback_query: {
        id: 'cb-stranger-1',
        from: { id: STRANGER, first_name: 'Edward' },
        message: {
          message_id: 7,
          message_thread_id: T_GABRIEL,
          chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
        },
        data: operar,
      },
    });
    const toast = world.client.answers().at(-1)?.text ?? '';
    expect(toast).toBe('Esta acción pertenece a Gabriel.');
    expectNoRawIds(toast);
    // Reply to Gabriel's labeled message is rejected too — first-writer-wins
    // keeps the label owned by Gabriel, never the same-name stranger.
    expect(world.interactions.resolveUserIdByName(GROUP_CHAT_ID, 'Gabriel')).toBe(GABRIEL);
    const label = world.client.texts().at(-1) ?? '';
    expect(label).toContain('👤 Operador: Gabriel');
    await world.post({
      update_id: world.nextUpdateId(),
      message: {
        message_id: 9,
        from: { id: STRANGER, first_name: 'Gabriel' },
        chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
        text: 'quiero operar',
        reply_to_message: {
          message_id: 2,
          from: { id: 999, first_name: 'VokathBot', is_bot: true },
          chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
          text: label,
        },
      },
    });
    const replyReject = world.client.texts().at(-1) ?? '';
    expect(replyReject).toBe('⚠️ Este requerimiento pertenece a Gabriel.');
    expectNoRawIds(replyReject);
    expect(world.drafts.get({ chatId: GROUP_CHAT_ID, userId: STRANGER })).toBeUndefined();
    await world.app.close();
  });

  it('7. missing profile resolves via member fetcher, persists, then cache-hits', async () => {
    // Andres NEVER interacts: no profile, no from fields anywhere.
    const world = await createOwnerWorld({
      members: new Map<number, ChatMember>([[ANDRES, { first_name: 'Andres' }]]),
    });
    expect(world.interactions.getOperatorProfile(ANDRES)).toBeUndefined();
    await world.post(
      ownerMessage(world.nextUpdateId(), GABRIEL, '/start', T_ANDRES, {
        first_name: 'Gabriel',
      }),
    );
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toBe('⚠️ Este espacio pertenece a Andres. Usa tu topic 👤 Gabriel.');
    expectNoRawIds(last);
    // Last-resort lookup fired once, then persisted to the profile store.
    expect((world.client as MemberStubClient).memberCalls).toHaveLength(1);
    expect(world.interactions.getOperatorProfile(ANDRES)?.displayName).toBe('Andres');
    // Second rejection is a pure store hit — no network on the hot path.
    await world.post(
      ownerMessage(world.nextUpdateId(), GABRIEL, '/start', T_ANDRES, {
        first_name: 'Gabriel',
      }),
    );
    expect(world.client.texts().at(-1)).toBe(
      '⚠️ Este espacio pertenece a Andres. Usa tu topic 👤 Gabriel.',
    );
    expect((world.client as MemberStubClient).memberCalls).toHaveLength(1);
    await world.app.close();
  });

  it('8. total fallback failure still renders non-empty, id-free UX', async () => {
    // Store-level: unknown user, failing fetcher, failing member map.
    const store = new InteractionStore();
    const failed = await store.resolveOwnerDisplayName(GROUP_CHAT_ID, 424242, {
      fetcher: async () => {
        throw new Error('network down');
      },
    });
    expect(failed).toBe('Usuario');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed).not.toContain('424242');
    const missing = await store.resolveOwnerDisplayName(GROUP_CHAT_ID, 434343, {
      fetcher: async () => undefined,
    });
    expect(missing).toBe('Usuario');
    expect(missing).not.toContain('434343');

    // Webhook-level with a bare stub (no getChatMember at all): the exact
    // mismatch string for a never-seen owner stays id-free.
    const world = await createOwnerWorld({ bareClient: true });
    await world.post(
      ownerMessage(world.nextUpdateId(), GABRIEL, '/start', T_ANDRES, {
        first_name: 'Gabriel',
      }),
    );
    const last = world.client.texts().at(-1) ?? '';
    expect(last).toBe('⚠️ Este espacio pertenece a Usuario. Usa tu topic 👤 Gabriel.');
    expect(last.length).toBeGreaterThan(0);
    expectNoRawIds(last);
    await world.app.close();
  });

  it('9. no raw ids in any ownership/mismatch message', async () => {
    const world = await createOwnerWorld();
    await world.post(
      ownerMessage(world.nextUpdateId(), EDWARD, '/start', T_EDWARD, {
        first_name: 'Edward',
      }),
    );
    await world.post(
      ownerMessage(world.nextUpdateId(), GABRIEL, '/start', T_GABRIEL, {
        first_name: 'Gabriel',
      }),
    );
    // Cross-topic mismatch (exact string).
    await world.post(
      ownerMessage(world.nextUpdateId(), GABRIEL, 'netflix', T_EDWARD, {
        first_name: 'Gabriel',
      }),
    );
    // Draft peer warning: Edward opens a draft, Gabriel confirms his own.
    const operar = world.client.findButton('⚡OPERAR');
    if (operar === undefined) {
      throw new Error('OPERAR button missing');
    }
    await world.post({
      update_id: world.nextUpdateId(),
      callback_query: {
        id: 'cb-edward-operar',
        from: { id: EDWARD, first_name: 'Edward' },
        message: {
          message_id: 11,
          message_thread_id: T_EDWARD,
          chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
        },
        data: operar,
      },
    });
    await world.post(
      ownerMessage(world.nextUpdateId(), GABRIEL, 'confirmar', T_GABRIEL, {
        first_name: 'Gabriel',
      }),
    );
    // Cross-actor button toast: Gabriel taps Edward's button.
    const edwardButton = world.client.findButton('⚡OPERAR');
    if (edwardButton !== undefined) {
      await world.post({
        update_id: world.nextUpdateId(),
        callback_query: {
          id: 'cb-gabriel-steal',
          from: { id: GABRIEL, first_name: 'Gabriel' },
          message: {
            message_id: 12,
            message_thread_id: T_GABRIEL,
            chat: { id: GROUP_CHAT_ID, type: 'supergroup' },
          },
          data: edwardButton,
        },
      });
    }
    const ownershipTexts = [
      ...world.client.texts().filter((text) => /pertenece/i.test(text)),
      ...world.client
        .answers()
        .map((answer) => answer.text ?? '')
        .filter((text) => text !== '' && /pertenece/i.test(text)),
    ];
    expect(ownershipTexts.length).toBeGreaterThan(0);
    for (const text of ownershipTexts) {
      expect(text.length).toBeGreaterThan(0);
      expectNoRawIds(text);
    }
    expect(ownershipTexts).toContain(
      '⚠️ Este espacio pertenece a Edward. Usa tu topic 👤 Gabriel.',
    );
    await world.app.close();
  });
});

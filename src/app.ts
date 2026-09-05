import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { GenaiIntentInterpreter, type IntentInterpreter } from './ai/intentInterpreter';
import { parseAuthorizedChatIds, parseAuthorizedIds } from './auth/allowlist';
import { type Auditor, createAuditor } from './audit/audit';
import { loadEnv, type Env } from './config/env';
import { DraftEngine } from './drafts/engine';
import { MockStore } from './mock/mockStore';
import { MockAccountRepositories, type MockRepositories } from './mock/repositories';
import { SessionStore } from './session/store';
import { HttpTelegramClient, type TelegramClient } from './telegram/client';
import { registerWebhook } from './telegram/setWebhook';
import { createWebhookHandler, isValidWebhookSecret } from './telegram/webhook';
import { logger } from './utils/logger';

export { isValidWebhookSecret };

const FIXTURE_FILENAME = 'BASE PRUEBA_v2.xlsx';

export interface HealthStatus {
  status: 'ok';
  telegram: string;
  gemini: string;
  mockStore: string;
}

/** Injectable collaborators — tests override; production wires real ones. */
export interface AppDeps {
  allowlist?: Set<number>;
  chatAllowlist?: Set<number>;
  sessions?: SessionStore;
  drafts?: DraftEngine;
  interpreter?: IntentInterpreter;
  repos?: MockRepositories;
  client?: TelegramClient;
  auditor?: Auditor;
  /** Draft snapshot path; undefined disables best-effort persist (tests). */
  draftsStatePath?: string;
}

export function buildApp(env: Env = loadEnv(), deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  const allowlist = deps.allowlist ?? parseAuthorizedIds(env.AUTHORIZED_TELEGRAM_USER_IDS);
  const chatAllowlist =
    deps.chatAllowlist ?? parseAuthorizedChatIds(env.AUTHORIZED_TELEGRAM_CHAT_IDS);
  const sessions = deps.sessions ?? new SessionStore();
  const drafts = deps.drafts ?? new DraftEngine();
  const interpreter =
    deps.interpreter ??
    new GenaiIntentInterpreter({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL });
  const repos = deps.repos ?? new MockAccountRepositories(MockStore.empty());
  const client = deps.client ?? new HttpTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const auditor = deps.auditor ?? createAuditor();
  const handleWebhook = createWebhookHandler({
    env,
    allowlist,
    chatAllowlist,
    sessions,
    drafts,
    interpreter,
    repos,
    client,
    auditor,
    ...(deps.draftsStatePath !== undefined ? { draftsStatePath: deps.draftsStatePath } : {}),
  });

  app.get('/health', async () => {
    const body: HealthStatus = {
      status: 'ok',
      telegram: 'configured',
      gemini: 'configured',
      mockStore: 'ready',
    };
    return body;
  });

  app.post('/telegram/webhook', handleWebhook);

  return app;
}

export async function startApp(): Promise<void> {
  const env = loadEnv();
  let repos: MockRepositories;

  try {
    const store = await MockStore.create({
      fixturePath: resolve(process.cwd(), 'fixtures', FIXTURE_FILENAME),
      statePath: env.MOCK_STATE_PATH,
    });
    repos = new MockAccountRepositories(store);
    logger.info({ accounts: store.accounts.length }, 'MOCK store loaded');
  } catch (error) {
    logger.error(error, 'Failed to load MOCK store — booting with empty store');
    repos = new MockAccountRepositories(MockStore.empty());
  }

  if (env.REGISTER_TELEGRAM_WEBHOOK === 'true') {
    try {
      const ok = await registerWebhook({
        telegramBotToken: env.TELEGRAM_BOT_TOKEN,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
      });
      logger.info({ registered: ok }, 'Telegram webhook registration attempted');
    } catch (error) {
      logger.error(error, 'Telegram webhook registration failed');
    }
  }

  // Drafts never expire: restore the snapshot so a restart loses nothing.
  // Missing file = first boot. A corrupt/failed load boots empty rather
  // than crashing — the group flow recreates drafts on demand.
  const drafts = new DraftEngine();
  try {
    await drafts.loadFromFile(env.DRAFTS_STATE_PATH);
    logger.info({ drafts: drafts.snapshot().length }, 'Draft snapshot loaded');
  } catch (error) {
    logger.error(error, 'Failed to load draft snapshot — booting with empty drafts');
  }

  const app = buildApp(env, { repos, drafts, draftsStatePath: env.DRAFTS_STATE_PATH });
  await app.listen({ host: '0.0.0.0', port: env.PORT });
  logger.info({ port: env.PORT }, 'Vokath bot listening');
}

const invokedAsMain =
  typeof process.argv[1] === 'string' && /app\.(ts|js)$/.test(process.argv[1]);

if (invokedAsMain) {
  startApp().catch((error) => {
    logger.error(error, 'Failed to start Vokath bot');
    process.exit(1);
  });
}

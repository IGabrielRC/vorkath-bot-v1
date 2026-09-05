import { describe, expect, it } from 'vitest';
import { isAuthorizedChat, parseAuthorizedChatIds } from '../src/auth/allowlist';
import { loadEnv } from '../src/config/env';

const validSource: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  TELEGRAM_BOT_TOKEN: 'tok',
  TELEGRAM_WEBHOOK_SECRET: 'sixteen-chars-min',
  AUTHORIZED_TELEGRAM_USER_IDS: '111111111,222222222',
  AUTHORIZED_TELEGRAM_CHAT_IDS: '-1001234567890',
  GEMINI_API_KEY: 'key',
  GEMINI_MODEL: 'gemini-2.0-flash',
  PUBLIC_BASE_URL: 'https://example.com',
  REGISTER_TELEGRAM_WEBHOOK: 'false',
  MOCK_STATE_PATH: '/data/mock-state.json',
  DRAFTS_STATE_PATH: '/data/drafts-state.json',
};

describe('loadEnv fail-fast', () => {
  it('parses the required variables', () => {
    const env = loadEnv({ ...validSource });
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('test');
  });

  it('treats AUTHORIZED_TELEGRAM_CHAT_IDS as optional', () => {
    const { AUTHORIZED_TELEGRAM_CHAT_IDS, ...withoutChatIds } = validSource;
    void AUTHORIZED_TELEGRAM_CHAT_IDS;
    const missing = loadEnv({ ...withoutChatIds });
    expect(missing.AUTHORIZED_TELEGRAM_CHAT_IDS).toBe('');
    const empty = loadEnv({ ...validSource, AUTHORIZED_TELEGRAM_CHAT_IDS: '' });
    expect(empty.AUTHORIZED_TELEGRAM_CHAT_IDS).toBe('');
    expect(parseAuthorizedChatIds('')).toEqual(new Set());
    expect(isAuthorizedChat(parseAuthorizedChatIds(''), -1001234567890)).toBe(true);
    expect(
      isAuthorizedChat(parseAuthorizedChatIds('-1001234567890'), -1009999999999),
    ).toBe(false);
  });

  it('throws when a secret is missing or too short', () => {
    expect(() => loadEnv({ ...validSource, TELEGRAM_BOT_TOKEN: '' })).toThrow();
    expect(() =>
      loadEnv({ ...validSource, TELEGRAM_WEBHOOK_SECRET: 'short' }),
    ).toThrow();
  });

  it('throws on malformed allowlist CSV or URL', () => {
    expect(() =>
      loadEnv({ ...validSource, AUTHORIZED_TELEGRAM_USER_IDS: 'not-an-id' }),
    ).toThrow();
    expect(() =>
      loadEnv({ ...validSource, AUTHORIZED_TELEGRAM_CHAT_IDS: 'not-a-chat-id' }),
    ).toThrow();
    expect(() => loadEnv({ ...validSource, PUBLIC_BASE_URL: 'nope' })).toThrow();
  });

  it('applies safe defaults for optional runtime variables', () => {
    const {
      NODE_ENV,
      PORT,
      REGISTER_TELEGRAM_WEBHOOK,
      MOCK_STATE_PATH,
      DRAFTS_STATE_PATH,
      ...rest
    } = validSource;
    void NODE_ENV;
    void PORT;
    void REGISTER_TELEGRAM_WEBHOOK;
    void MOCK_STATE_PATH;
    void DRAFTS_STATE_PATH;
    const env = loadEnv({ ...rest });
    expect(env.PORT).toBe(3000);
    expect(env.REGISTER_TELEGRAM_WEBHOOK).toBe('false');
    expect(env.MOCK_STATE_PATH).toBe('/data/mock-state.json');
    expect(env.DRAFTS_STATE_PATH).toBe('/data/drafts-state.json');
  });
});

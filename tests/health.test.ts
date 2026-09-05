import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Env } from '../src/config/env';

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  TELEGRAM_BOT_TOKEN: 'tok-test-secret',
  TELEGRAM_WEBHOOK_SECRET: 'wh-test-secret-long-enough',
  AUTHORIZED_TELEGRAM_USER_IDS: '111111111,222222222',
  GEMINI_API_KEY: 'key-test-secret',
  GEMINI_MODEL: 'gemini-2.0-flash',
  PUBLIC_BASE_URL: 'https://example.com',
  REGISTER_TELEGRAM_WEBHOOK: 'false',
  MOCK_STATE_PATH: '/data/mock-state.json',
};

describe('GET /health', () => {
  it('returns exactly the 4 safe fields with no secret substrings', async () => {
    const app = buildApp(testEnv);
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['gemini', 'mockStore', 'status', 'telegram'].sort(),
    );
    const raw = response.body;
    for (const secret of [
      testEnv.TELEGRAM_BOT_TOKEN,
      testEnv.TELEGRAM_WEBHOOK_SECRET,
      testEnv.GEMINI_API_KEY,
    ]) {
      expect(raw).not.toContain(secret);
    }
    await app.close();
  });
});

describe('POST /telegram/webhook secret gate', () => {
  it('rejects a wrong secret with 401 before processing', async () => {
    const app = buildApp(testEnv);
    const response = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
      payload: { update_id: 1, message: { text: '/start' } },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false });
    await app.close();
  });

  it('accepts the configured secret (skeleton)', async () => {
    const app = buildApp(testEnv);
    const response = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: {
        'x-telegram-bot-api-secret-token': testEnv.TELEGRAM_WEBHOOK_SECRET,
      },
      payload: { update_id: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });
});

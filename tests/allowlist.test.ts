import { describe, expect, it } from 'vitest';
import { isAuthorized, parseAuthorizedIds } from '../src/auth/allowlist';

// Gabriel + Edward ids come from the environment in production; test values only.
const GABRIEL_ID = 111111111;
const EDWARD_ID = 222222222;
const UNKNOWN_ID = 999999999;

describe('owner allowlist', () => {
  it('authorizes ids from the CSV env value with zero side-effects', () => {
    const allowlist = parseAuthorizedIds(`${GABRIEL_ID}, ${EDWARD_ID}`);

    expect(isAuthorized(allowlist, GABRIEL_ID)).toBe(true);
    expect(isAuthorized(allowlist, EDWARD_ID)).toBe(true);
    expect(isAuthorized(allowlist, UNKNOWN_ID)).toBe(false);
  });

  it('rejects empty and malformed CSV input fail-fast', () => {
    expect(() => parseAuthorizedIds('')).toThrow();
    expect(() => parseAuthorizedIds('abc,123')).toThrow();
    expect(() => parseAuthorizedIds('0,-5')).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { FUTURE_TOOL_NAMES, createMockRegistry } from '../src/tools/mockTools';

describe('ToolRegistry + mockTools (RED: demo tools real, future contracts stubbed)', () => {
  it('exposes demo tools that run without real side-effects', async () => {
    const registry = createMockRegistry();
    const result = (await registry.run('demoSearch', { query: 'gabriel' }, 111)) as {
      mock: boolean;
    };
    expect(result.mock).toBe(true);
  });

  it('stubs every future contract with no logic (searchCustomer…getInstallCode)', async () => {
    const registry = createMockRegistry();
    expect(FUTURE_TOOL_NAMES).toEqual(
      expect.arrayContaining(['searchCustomer', 'getInstallCode', 'prepareSale']),
    );
    for (const name of FUTURE_TOOL_NAMES) {
      const result = (await registry.run(name, {}, 111)) as { ok: boolean; mock: boolean };
      expect(result).toMatchObject({ ok: false, mock: true });
    }
  });

  it('rejects unknown tools instead of guessing', async () => {
    const registry = createMockRegistry();
    await expect(registry.run('dropDatabase', {}, 111)).rejects.toThrow(/unknown tool/i);
  });
});

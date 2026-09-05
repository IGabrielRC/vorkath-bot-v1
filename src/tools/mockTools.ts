import type { MockRepositories } from '../mock/repositories';
import { ToolRegistry, type MockTool } from './registry';

/**
 * Demo tools (real canned MOCK behavior, zero real side-effects) plus
 * future-contract stubs. Stubs return a MOCK marker — they contain
 * no logic by design; Fase 1 wires them to the MockStore.
 *
 * When a `MockRepositories` is provided, `demoSearch` consumes the repo
 * seam (safe, secret-free rows) instead of the canned rows — tools
 * consume repos, never spreadsheet columns.
 */

export const DEMO_TOOL_NAMES = ['demoSearch', 'demoCreateTest'] as const;

/** Future contracts from the spec — stubbed, no logic. */
export const FUTURE_TOOL_NAMES = [
  'searchCustomer',
  'searchAccount',
  'getCustomerDetails',
  'getAccountDetails',
  'getCredentials',
  'prepareSale',
  'prepareRenewal',
  'getExpired',
  'getInventory',
  'getRate',
  'getPrices',
  'getInstallCode',
] as const;

const DEMO_ROWS = [
  { correo: 'demo1@example.com', perfil: 'Netflix P1', pais: 'VE' },
  { correo: 'demo2@example.com', perfil: 'FlujoTV P2', pais: 'VE' },
];

const demoSearch: MockTool = {
  name: 'demoSearch',
  description: 'Demo MOCK search over canned rows (or the repo seam when provided).',
  run: async (args: Record<string, unknown>, _userId: number): Promise<unknown> => {
    const query = typeof args['query'] === 'string' ? args['query'].toLowerCase() : '';
    const rows =
      query.length === 0
        ? DEMO_ROWS
        : DEMO_ROWS.filter((row) => JSON.stringify(row).toLowerCase().includes(query));
    return { ok: true, mock: true, tool: 'demoSearch', rows };
  },
};

/** `demoSearch` bound to the repo seam — returns safe, secret-free rows. */
function repoBackedSearch(repos: MockRepositories): MockTool {
  return {
    name: 'demoSearch',
    description: 'Demo MOCK search over the MockRepositories seam (safe rows).',
    run: async (args: Record<string, unknown>, _userId: number): Promise<unknown> => {
      const query = typeof args['query'] === 'string' ? args['query'] : '';
      const rows = await repos.searchAccounts(query);
      return { ok: true, mock: true, tool: 'demoSearch', rows };
    },
  };
}

const demoCreateTest: MockTool = {
  name: 'demoCreateTest',
  description: 'Demo MOCK draft seed (months only, no real provisioning).',
  run: async (args: Record<string, unknown>, _userId: number): Promise<unknown> => {
    const months = typeof args['months'] === 'number' ? args['months'] : 1;
    return { ok: true, mock: true, tool: 'demoCreateTest', draft: { months } };
  },
};

function futureStub(name: string): MockTool {
  return {
    name,
    description: `MOCK stub — ${name} has no logic yet (PR3+ wires it to the MockStore).`,
    run: async (_args: Record<string, unknown>, _userId: number): Promise<unknown> => ({
      ok: false,
      mock: true,
      tool: name,
      note: 'MOCK stub — no real logic',
    }),
  };
}

/** Registry preloaded with demo tools + future-contract stubs. */
export function createMockRegistry(repos?: MockRepositories): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(repos !== undefined ? repoBackedSearch(repos) : demoSearch);
  registry.register(demoCreateTest);
  for (const name of FUTURE_TOOL_NAMES) {
    registry.register(futureStub(name));
  }
  return registry;
}

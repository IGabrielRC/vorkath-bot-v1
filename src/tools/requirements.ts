/**
 * ToolRequirementResolver — the central "ask only what is missing"
 * mechanism (transversal, phases 2-15).
 *
 * Every NL intent resolves to a tool + the params the user already
 * gave. `resolveMissingFields` compares the tool's required params
 * against the provided/resolved values:
 * - missingFields empty → READ actions execute immediately with NO
 *   confirmation (search customer/account, expired, inventory, caja
 *   queries); WRITE/CRITICAL with full data builds a DRAFT + summary +
 *   Confirm/Correct/Cancel (never executes directly).
 * - missingFields non-empty → the bot asks ONLY those fields,
 *   completing the same draft/context, and confirms when complete.
 *
 * The interpreter NEVER invents missing params, so a missing field
 * always produces a question — never a guess, never a silent default.
 */

import type { IntentName } from '../ai/intentInterpreter';

export type ToolKind = 'read' | 'write';

export interface ToolSpec {
  tool: string;
  kind: ToolKind;
  /** Required param names (camelCase, as they appear in intent params). */
  required: string[];
}

/**
 * Tool catalogue. Search tools need exactly one identifier (phone,
 * email, neutral account id, or name — the repo discovers the service
 * from the row, so the bot never asks "¿Netflix o FlujoTV?").
 * Mutation/draft tools need their complete payload before a draft is
 * summarized for confirmation.
 */
const TOOL_SPECS: Record<string, ToolSpec> = {
  searchAccount: { tool: 'searchAccount', kind: 'read', required: ['identifier'] },
  searchCustomer: { tool: 'searchCustomer', kind: 'read', required: ['identifier'] },
  getCustomerDetails: { tool: 'getCustomerDetails', kind: 'read', required: ['identifier'] },
  getAccountDetails: { tool: 'getAccountDetails', kind: 'read', required: ['identifier'] },
  getCredentials: { tool: 'getCredentials', kind: 'read', required: ['identifier'] },
  getExpired: { tool: 'getExpired', kind: 'read', required: [] },
  getInventory: { tool: 'getInventory', kind: 'read', required: [] },
  getRate: { tool: 'getRate', kind: 'read', required: [] },
  getPrices: { tool: 'getPrices', kind: 'read', required: [] },
  getInstallCode: { tool: 'getInstallCode', kind: 'read', required: ['identifier'] },
  demoSearch: { tool: 'demoSearch', kind: 'read', required: ['identifier'] },
  demoCreateTest: { tool: 'demoCreateTest', kind: 'write', required: ['months'] },
  prepareSale: { tool: 'prepareSale', kind: 'write', required: ['identifier', 'months'] },
  prepareRenewal: { tool: 'prepareRenewal', kind: 'write', required: ['identifier', 'months'] },
};

export function getToolSpec(tool: string): ToolSpec | undefined {
  return TOOL_SPECS[tool];
}

/**
 * Fail-closed intent→mutation policy (WRITE safe-default, transversal).
 *
 * Every intent declares its mutation power up front:
 * - `read` — deterministic reads only, never touches the draft store.
 * - `draft-shell` — the explicit OPERAR-twin shell / correction of an
 *   already-open draft; never creates a draft from ambiguous text.
 * - `guarded-draft` — may build a draft ONLY after the dispatcher
 *   verifies an unequivocal creation expression in the raw text
 *   (`isExplicitCreateRequest`); otherwise it degrades to READ/UNKNOWN.
 * - `none` — must NEVER execute a mutation: no draft create/update/
 *   confirm/cancel, no repo write. Ambiguous WRITE intent lands here.
 *
 * The `Record<IntentName, …>` type is the future-proofing: adding a new
 * intent to `INTENT_NAMES` without classifying it here is a COMPILE
 * error, so no future WRITE intent can silently inherit mutation power.
 */
export type IntentMutationPolicy = 'read' | 'draft-shell' | 'guarded-draft' | 'none';

export const INTENT_MUTATION_POLICY: Record<IntentName, IntentMutationPolicy> = {
  OPEN_SEARCH: 'read',
  CREATE_TEST_DRAFT: 'guarded-draft',
  CORRECTION: 'draft-shell',
  OPEN_OPERATE: 'draft-shell',
  OPEN_EXPIRED: 'read',
  OPEN_INVENTORY: 'read',
  OPEN_CASH: 'read',
  OPEN_MORE: 'read',
  UNKNOWN: 'none',
};

/** True for immediate-execution reads (no confirmation ever). */
export function isReadTool(tool: string): boolean {
  return TOOL_SPECS[tool]?.kind === 'read';
}

/**
 * Required params with no usable value in `provided`. A value counts
 * as provided when it is a non-empty string or a finite number —
 * everything else (undefined, null, '', NaN) stays missing so the app
 * asks only for it.
 */
export function resolveMissingFields(
  tool: string,
  provided: Record<string, unknown>,
): string[] {
  const spec = TOOL_SPECS[tool];
  if (spec === undefined) {
    return [];
  }
  return spec.required.filter((field) => !hasUsableValue(provided[field]));
}

function hasUsableValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  return value !== undefined && value !== null;
}

/** Ask-only texts: each names exactly the missing field, nothing more. */
export const ASK_IDENTIFIER_TEXT =
  '🔎 ¿Qué teléfono, nombre u otro dato quieres buscar? Envía el dato y lo reviso.';
export const ASK_ACCOUNT_TEXT =
  '🔎 ¿Qué cuenta quieres revisar? Envía el usuario, correo, teléfono o nombre.';
export const ASK_MONTHS_TEXT =
  '📝 ¿Por cuántos meses? Envía la corrección (ej. «hazlo 2 meses»).';

export function askTextFor(field: string): string {
  switch (field) {
    case 'identifier':
      return ASK_IDENTIFIER_TEXT;
    case 'months':
      return ASK_MONTHS_TEXT;
    default:
      return ASK_IDENTIFIER_TEXT;
  }
}

/**
 * Picks the search identifier out of intent params, accepting every
 * alias the interpreter may produce. Returns undefined when the user
 * gave nothing — missing stays missing.
 */
export function pickSearchIdentifier(params: Record<string, unknown>): string | undefined {
  for (const key of ['identifier', 'query', 'phone', 'email', 'account', 'usuario']) {
    const value = params[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

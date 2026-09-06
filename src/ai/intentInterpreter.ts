import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';
import { extractEmbeddedAccount, parseEmail, parseMonths, parsePhone } from '../parser/fast';

/**
 * L3 Gemini intent interpreter: intent-only, never executes.
 * The model returns {intent, params} JSON (responseMimeType +
 * responseJsonSchema, zod re-validated); the app executes
 * deterministically. On timeout/invalid output → UNKNOWN fallback
 * so buttons keep working.
 * Sources: /googleapis/js-genai — ai.models.generateContent with
 * `config.responseMimeType: "application/json"` + `responseJsonSchema`.
 */

export const INTENT_NAMES = ['OPEN_SEARCH', 'CREATE_TEST_DRAFT', 'CORRECTION', 'UNKNOWN'] as const;

export type IntentName = (typeof INTENT_NAMES)[number];

export const intentSchema = z.object({
  name: z.enum(INTENT_NAMES),
  params: z.record(z.unknown()).default({}),
  /**
   * Caller confidence 0..1 (optional). The deterministic stub always
   * reports 1; the production model may include it. Absence never
   * blocks execution — the app decides from intent + params only.
   */
  confidence: z.number().min(0).max(1).optional(),
});

export type Intent = z.infer<typeof intentSchema>;

/**
 * IntentResult contract (transversal, phases 2-15): NL produces
 * `{ intent, parameters, confidence }` where `parameters` carries ONLY
 * what the user explicitly gave:
 * - `identifier` — phone, email, or neutral account id found verbatim
 *   in the text (e.g. `maxnet050`, `4145460657`, `a@b.com`),
 * - `reference: 'last'` — conversational pointer to the actor's own
 *   previous result ("esa misma", "ese", "la anterior") with NO new
 *   identifier; the app resolves it from the actor's own context only,
 * - `months` — month count stated verbatim (corrections / test drafts).
 *
 * The interpreter NEVER invents an absent parameter, NEVER mutates
 * anything, and NEVER skips guards: missing stays missing so the app
 * can ask only for what is missing.
 */

/**
 * Per-actor context for Gemini. The interpreter receives ONLY the acting
 * operator's identity (chatId + userId + display name) — never the shared
 * group's mutable session, never a peer's draft/search state. Intent-only:
 * the model classifies, the app executes deterministically.
 */
export interface SessionCtx {
  userId: number;
  chatId?: number;
  /** Forum topic id — actor context scope, never a substitute for userId. */
  messageThreadId?: number;
  ownerName?: string;
}

export interface IntentInterpreter {
  interpret(text: string, ctx: SessionCtx): Promise<Intent>;
}

export const UNKNOWN_INTENT: Intent = { name: 'UNKNOWN', params: {} };

/** Plain JSON Schema for the model's structured output (responseJsonSchema). */
const INTENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      enum: [...INTENT_NAMES],
      description: 'The detected user intent.',
    },
    params: {
      type: 'object',
      description: 'Intent parameters (e.g. months for CORRECTION).',
      additionalProperties: true,
    },
  },
  required: ['name'],
  propertyOrdering: ['name', 'params'],
};

const SYSTEM_PROMPT =
  'You classify Telegram bot messages into intents. ' +
  'Reply with JSON only: {"name": <OPEN_SEARCH|CREATE_TEST_DRAFT|CORRECTION|UNKNOWN>, "params": {...}}. ' +
  'OPEN_SEARCH: user wants to search a customer/account. ' +
  'CREATE_TEST_DRAFT: user wants to create a test/demo operation. ' +
  'CORRECTION: user corrects an open draft (params.months = month count when mentioned). ' +
  'Otherwise UNKNOWN. ' +
  'Interpretation ONLY: never execute, never mutate, never skip guards. ' +
  'Extract intent/params/references/corrections verbatim from the text: ' +
  'params.identifier = the phone, email, or account id stated verbatim ' +
  '(or params.reference="last" for "esa misma"/"ese"/"la anterior" with no new id); ' +
  'params.months = the month count stated verbatim. ' +
  'NEVER invent a missing param: omit absent fields so the app asks ' +
  'only for what is missing. Optionally include "confidence" 0..1.';

/** Deterministic stub for tests and offline runs. Counts calls so L1/L2 tests prove zero Gemini usage. */
export class StubIntentInterpreter implements IntentInterpreter {
  calls = 0;

  async interpret(text: string, _ctx: SessionCtx): Promise<Intent> {
    this.calls += 1;
    const lowered = text.toLowerCase();
    const monthsMatch = /(\d{1,2})\s*mes(?:es)?\b/.exec(lowered);
    if (/(mejor|cambia|hazlo|corrige|correcci)/.test(lowered) && monthsMatch?.[1] !== undefined) {
      return { name: 'CORRECTION', params: { months: Number(monthsMatch[1]) }, confidence: 1 };
    }
    // Identifier found verbatim in the text → the app searches it
    // directly (ask-only-what-is-missing: nothing is missing).
    const identifier = extractStubIdentifier(text);
    if (identifier !== undefined) {
      return { name: 'OPEN_SEARCH', params: { identifier }, confidence: 1 };
    }
    // Conversational pointer with NO new identifier → the app resolves
    // it from the actor's own context, never a peer's.
    if (/(esa|ese|eso|misma|mismo|esta|este|anterior|última|ultima)\b/.test(lowered)) {
      return { name: 'OPEN_SEARCH', params: { reference: 'last' }, confidence: 1 };
    }
    if (/\b(busc|revis|consult|mir|ficha|cliente|cuenta|vence|vencim|pasa con|dime|averigua)\w*\b/.test(lowered)) {
      return { name: 'OPEN_SEARCH', params: {}, confidence: 1 };
    }
    if (/(crea|crear|prueba|demo|test|opera)/.test(lowered)) {
      // Months ONLY when stated — never invented (missing stays missing).
      const months = parseMonths(text);
      return {
        name: 'CREATE_TEST_DRAFT',
        params: months === null ? {} : { months: months.months },
        confidence: 1,
      };
    }
    return { name: 'UNKNOWN', params: {}, confidence: 1 };
  }
}

/**
 * Stub-side identifier extraction (same deterministic extractors as
 * L2 — email anywhere, phone >=7 digits, neutral account token).
 * Returns undefined when nothing was stated: missing stays missing.
 */
function extractStubIdentifier(text: string): string | undefined {
  const email = parseEmail(text);
  if (email !== null) {
    return email.value;
  }
  const phone = parsePhone(text);
  if (phone !== null) {
    return phone.value;
  }
  const account = extractEmbeddedAccount(text);
  if (account !== null) {
    return account.value;
  }
  return undefined;
}

export interface GenaiInterpreterOpts {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Injectable raw-text generator — tests stub this, production uses the SDK. */
  generate?: (prompt: string) => Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Production interpreter backed by @google/genai structured JSON output. */
export class GenaiIntentInterpreter implements IntentInterpreter {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly generate: (prompt: string) => Promise<string>;

  constructor(opts: GenaiInterpreterOpts) {
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (opts.generate !== undefined) {
      this.generate = opts.generate;
    } else {
      const client = new GoogleGenAI({ apiKey: opts.apiKey });
      const model = opts.model;
      this.generate = async (prompt: string): Promise<string> => {
        const response = await client.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            responseJsonSchema: INTENT_JSON_SCHEMA,
          },
        });
        return response.text ?? '';
      };
    }
  }

  async interpret(text: string, ctx: SessionCtx): Promise<Intent> {
    const who =
      ctx.ownerName !== undefined
        ? `User ${ctx.userId} (${ctx.ownerName})`
        : `User ${ctx.userId}`;
    const where = ctx.chatId !== undefined ? ` in chat ${ctx.chatId}` : '';
    const prompt = `${SYSTEM_PROMPT}\n${who}${where} says: ${text}`;
    try {
      const raw = await this.withTimeout(this.generate(prompt));
      const parsedJson: unknown = JSON.parse(raw);
      const parsed = intentSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return { ...UNKNOWN_INTENT };
      }
      return parsed.data;
    } catch {
      return { ...UNKNOWN_INTENT };
    }
  }

  private withTimeout(work: Promise<string>): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<string>((_, reject) => {
      timer = setTimeout(() => reject(new Error('gemini-timeout')), this.timeoutMs);
      timer.unref?.();
    });
    return Promise.race([work, timeout]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  }
}

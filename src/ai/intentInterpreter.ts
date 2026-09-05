import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';

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
});

export type Intent = z.infer<typeof intentSchema>;

/**
 * Per-actor context for Gemini. The interpreter receives ONLY the acting
 * operator's identity (chatId + userId + display name) — never the shared
 * group's mutable session, never a peer's draft/search state. Intent-only:
 * the model classifies, the app executes deterministically.
 */
export interface SessionCtx {
  userId: number;
  chatId?: number;
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
  'Otherwise UNKNOWN.';

/** Deterministic stub for tests and offline runs. Counts calls so L1/L2 tests prove zero Gemini usage. */
export class StubIntentInterpreter implements IntentInterpreter {
  calls = 0;

  async interpret(text: string, _ctx: SessionCtx): Promise<Intent> {
    this.calls += 1;
    const lowered = text.toLowerCase();
    const monthsMatch = /(\d{1,2})\s*mes(?:es)?\b/.exec(lowered);
    if (/(mejor|cambia|hazlo|corrige|correcci)/.test(lowered) && monthsMatch?.[1] !== undefined) {
      return { name: 'CORRECTION', params: { months: Number(monthsMatch[1]) } };
    }
    if (/busc(ar|a|o)?\b/.test(lowered)) {
      return { name: 'OPEN_SEARCH', params: {} };
    }
    if (/(crea|crear|prueba|demo|test|opera)/.test(lowered)) {
      return { name: 'CREATE_TEST_DRAFT', params: { months: 1 } };
    }
    return { name: 'UNKNOWN', params: {} };
  }
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

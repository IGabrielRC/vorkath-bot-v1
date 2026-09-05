import type { Intent, IntentInterpreter } from '../ai/intentInterpreter';
import { type FastParseResult, parseFast } from '../parser/fast';
import { parseCallback } from '../telegram/keyboards';

/**
 * Hybrid router cascade: L1 exact-callback → L2 fast-parser → L3 Gemini.
 * L1/L2 never touch the interpreter (zero Gemini calls); only "none"
 * from the fast parser falls through to L3. Stale callbacks degrade
 * to a safe no-op.
 */

export interface RouterCtx {
  userId: number;
  /** Shared-group chat id (context only — routing never assumes private chat). */
  chatId?: number;
  text?: string;
  callbackData?: string;
}

export type RouterDecision =
  | { layer: 'L1'; action: string }
  | { layer: 'L2'; parse: FastParseResult }
  | { layer: 'L3'; intent: Intent }
  | { layer: 'noop'; reason: string };

/**
 * Routes one update. The interpreter is invoked only when L1 and L2
 * both miss — pass a StubIntentInterpreter in tests to prove it.
 */
export async function route(ctx: RouterCtx, interpreter: IntentInterpreter): Promise<RouterDecision> {
  if (ctx.callbackData !== undefined) {
    const action = parseCallback(ctx.callbackData);
    if (action !== null) {
      return { layer: 'L1', action };
    }
    return { layer: 'noop', reason: 'stale-callback' };
  }

  const text = ctx.text?.trim() ?? '';
  // Group commands arrive with the bot mention suffix (`/start@VokathBot`)
  // when tapped from the command menu — strip it before matching.
  const withoutMention =
    text.startsWith('/') && text.includes('@') ? text.slice(0, text.indexOf('@')) : text;
  if (withoutMention === '/start') {
    return { layer: 'L1', action: 'home' };
  }

  if (text.length > 0) {
    const parse = parseFast(text);
    if (parse.kind !== 'none') {
      return { layer: 'L2', parse };
    }
    const intent = await interpreter.interpret(text, { userId: ctx.userId });
    return { layer: 'L3', intent };
  }

  return { layer: 'noop', reason: 'empty-update' };
}

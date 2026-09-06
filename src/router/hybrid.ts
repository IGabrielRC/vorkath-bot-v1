import type { Intent, IntentInterpreter } from '../ai/intentInterpreter';
import { type FastParseResult, parseFast } from '../parser/fast';
import { parseCallbackData } from '../telegram/keyboards';

/**
 * Hybrid router cascade: L1 exact-callback → L2 fast-parser → L3 Gemini.
 * L1/L2 never touch the interpreter (zero Gemini calls); only "none"
 * from the fast parser falls through to L3. Stale callbacks degrade
 * to a safe no-op.
 *
 * TRANSVERSAL CONVERSATIONAL CONTRACT (applies to phases 2-15):
 * - Button taps and natural-language requests are equivalent inputs:
 *   both entries resolve to the SAME intents and call the SAME
 *   deterministic tools (search repo, draft engine, interaction store).
 *   No business logic is duplicated between callback/command/NL
 *   handlers and tools — handlers only route, tools execute.
 * - Local deterministic parsing (L1 callbacks, L2 fast parser) runs
 *   FIRST; Gemini (L3) only interprets ambiguous text into intents and
 *   never executes anything itself.
 * - The central topic-ownership guard runs BEFORE this router: foreign
 *   or cross-topic input reaches neither Gemini nor any tool.
 * - Responses carry the actor's profile displayName; authorization and
 *   ownership are keyed by numeric telegramUserId only — never by name.
 * - Button↔NL equivalence is locked by tests asserting shared entry
 *   points (spies on the tool/registry layer) and Gemini-call counting.
 */

export interface RouterCtx {
  userId: number;
  /** Shared-group chat id (context only — routing never assumes private chat). */
  chatId?: number;
  /** Forum topic id — part of the context scope, never a replacement for userId. */
  messageThreadId?: number;
  /** Acting operator display name — forwarded to Gemini, never a peer's. */
  ownerName?: string;
  text?: string;
  callbackData?: string;
}

export type RouterDecision =
  | { layer: 'L1'; action: string; interactionId?: string }
  | { layer: 'L2'; parse: FastParseResult }
  | { layer: 'L3'; intent: Intent }
  | { layer: 'noop'; reason: string };

/**
 * Routes one update. The interpreter is invoked only when L1 and L2
 * both miss — pass a StubIntentInterpreter in tests to prove it.
 * L1 callbacks resolve through interaction-bound data when present
 * (`v1:<short>:<interactionId>`); legacy unbound buttons carry no id.
 */
export async function route(ctx: RouterCtx, interpreter: IntentInterpreter): Promise<RouterDecision> {
  if (ctx.callbackData !== undefined) {
    const parsed = parseCallbackData(ctx.callbackData);
    if (parsed !== null) {
      return {
        layer: 'L1',
        action: parsed.action,
        ...(parsed.interactionId !== undefined ? { interactionId: parsed.interactionId } : {}),
      };
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
    const intent = await interpreter.interpret(text, {
      userId: ctx.userId,
      ...(ctx.chatId !== undefined ? { chatId: ctx.chatId } : {}),
      ...(ctx.messageThreadId !== undefined ? { messageThreadId: ctx.messageThreadId } : {}),
      ...(ctx.ownerName !== undefined ? { ownerName: ctx.ownerName } : {}),
    });
    return { layer: 'L3', intent };
  }

  return { layer: 'noop', reason: 'empty-update' };
}

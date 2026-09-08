/**
 * Central pre-send Telegram length guard (transversal infra).
 *
 * Telegram caps `sendMessage`/`editMessageText` text at 4096 characters
 * (UTF-16 code units — hence `text.length`, not code points).
 * See: https://core.telegram.org/bots/api#sendmessage
 *
 * `splitTelegramText` is the ONE place oversized cards are cut down:
 * - Lines are NEVER broken or dropped when they fit: parts accumulate
 *   whole `\n`-separated lines, so phones, amounts, dates, identifiers
 *   and every other critical token survive verbatim in exactly one part.
 * - No HTML tag or entity is ever cut: a chunk boundary never lands
 *   inside `<…>` or `&…;` (the cut backs off to the `<`/`&` start).
 * - A single over-long line (no `\n` to split on) is hard-cut at safe
 *   boundaries only — same verbatim-preservation, no summarization.
 *
 * Callers send `parts[0]` through the normal edit-or-send path and any
 * remainder as follow-up sends on the same thread. Short texts return
 * a single part — byte-identical, zero behavior change.
 */

export const TELEGRAM_MAX_TEXT_LENGTH = 4096;

/** Approximate pre-send measure (UTF-16 code units, matching the API cap). */
export function measureTelegramText(text: string): number {
  return text.length;
}

/** True when the text fits in a single Telegram message. */
export function fitsTelegramLimit(text: string, limit: number = TELEGRAM_MAX_TEXT_LENGTH): boolean {
  return measureTelegramText(text) <= limit;
}

/**
 * Splits text into parts that each fit `limit`. Whole-line chunking
 * first; safe hard-cut only for single lines longer than `limit`.
 */
export function splitTelegramText(text: string, limit: number = TELEGRAM_MAX_TEXT_LENGTH): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const parts: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current !== '') {
      parts.push(current);
      current = '';
    }
  };
  for (const line of text.split('\n')) {
    if (line.length > limit) {
      flush();
      for (const chunk of splitLongLine(line, limit)) {
        parts.push(chunk);
      }
      continue;
    }
    const candidate = current === '' ? line : `${current}\n${line}`;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      flush();
      current = line;
    }
  }
  flush();
  return parts.length > 0 ? parts : [text];
}

/**
 * Hard-cuts one over-long line at `limit` without ever splitting an
 * HTML tag (`<…>`) or entity (`&…;`): when the cut lands inside one,
 * it backs off to the `<`/`&` start. Chunks rejoin to the exact input.
 */
function splitLongLine(line: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = line;
  while (rest.length > limit) {
    let cut = limit;
    const head = rest.slice(0, cut);
    const openTag = head.search(/<[^<>]*$/);
    const openEntity = head.search(/&[A-Za-z0-9#]*$/);
    const backoff = Math.max(openTag, openEntity);
    if (backoff > 0) {
      cut = backoff;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== '' || chunks.length === 0) {
    chunks.push(rest);
  }
  return chunks;
}

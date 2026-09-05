/**
 * Owner allowlist. IDs come exclusively from the
 * AUTHORIZED_TELEGRAM_USER_IDS environment variable (Gabriel + Edward,
 * equal owners). Nothing is hardcoded here by design.
 */
export function parseAuthorizedIds(raw: string): Set<number> {
  const ids = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part));

  if (ids.length === 0) {
    throw new Error('AUTHORIZED_TELEGRAM_USER_IDS must contain at least one id');
  }
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`Invalid Telegram user id in allowlist: ${String(id)}`);
    }
  }
  return new Set(ids);
}

export function isAuthorized(allowlist: Set<number>, userId: number): boolean {
  return allowlist.has(userId);
}

import { logger as defaultLogger } from '../utils/logger';

/**
 * Shared-group audit trail. Every security or draft-lifecycle decision in
 * the webhook is recorded here with the acting operator's identity
 * (chatId + actorTelegramUserId + actorName) — the group chat itself is
 * the shared channel, so audit emits NO user-facing notification.
 *
 * Privacy: events carry safe metadata only (months, status, counts).
 * NEVER pass passwords, PINs, credentials, or tokens in `metadata` —
 * the pino redaction list is a backstop, not a permit.
 */

export interface AuditEvent {
  timestamp: string;
  chatId: number;
  actorTelegramUserId: number;
  actorName?: string;
  actionType: string;
  /** Related entity/draft, e.g. `draft:<chatId>:<userId>`. */
  entity?: string;
  /** Safe, secret-free metadata only. */
  metadata?: Record<string, unknown>;
}

export type AuditEventInput = Omit<AuditEvent, 'timestamp'> & {
  timestamp?: string;
};

/** Injectable sink — tests pass an array collector; production uses pino. */
export type AuditSink = (event: AuditEvent) => void;

export interface Auditor {
  record(input: AuditEventInput): void;
}

export function createAuditor(sink?: AuditSink): Auditor {
  return {
    record(input: AuditEventInput): void {
      const event: AuditEvent = {
        ...input,
        timestamp: input.timestamp ?? new Date().toISOString(),
      };
      if (sink !== undefined) {
        sink(event);
        return;
      }
      defaultLogger.info(
        {
          audit: true,
          chatId: event.chatId,
          actorTelegramUserId: event.actorTelegramUserId,
          actorName: event.actorName,
          actionType: event.actionType,
          entity: event.entity,
          metadata: event.metadata,
        },
        'audit event',
      );
    },
  };
}

/** No-op auditor for contexts where audit output is unwanted. */
export function nullAuditor(): Auditor {
  return { record(): void {} };
}

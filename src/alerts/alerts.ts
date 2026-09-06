import type { TelegramClient } from '../telegram/client';
import { renderAlert } from '../telegram/render';
import { logger } from '../utils/logger';

/**
 * Central alert delivery (⭐ Alertas topic).
 *
 * Diagnostic/infra layer only: it renders caller-provided strings into the
 * alerts forum topic and NOTHING else. It never reads business state, never
 * calls Gemini, never creates drafts or interactions. NEVER pass secrets
 * (tokens, passwords, PINs, API keys) inside `title`/`summary` — the text
 * is posted verbatim into the shared group.
 */
export interface CriticalAlert {
  type: string;
  title: string;
  summary: string;
  actorName?: string;
  timestamp?: string;
}

export interface AlertTarget {
  chatId: number;
  /** Forum thread receiving the alert (`message_thread_id` on the wire). */
  alertsThreadId?: number;
}

/** Pure renderer — safe to unit-test without any Telegram dependency. */
export function buildAlertText(alert: CriticalAlert): string {
  return renderAlert(alert);
}

export class AlertService {
  constructor(private readonly client: TelegramClient) {}

  /**
   * Sends one critical alert to the alerts topic. Returns 'disabled'
   * (and only logs) when no alerts topic is configured — absence of
   * TELEGRAM_ALERTS_TOPIC_ID never breaks startup, /health, or callers.
   */
  async sendCriticalAlert(
    target: AlertTarget,
    alert: CriticalAlert,
  ): Promise<'sent' | 'disabled'> {
    if (target.alertsThreadId === undefined) {
      logger.info(
        { chatId: target.chatId, type: alert.type },
        'Alerts topic not configured — alert skipped',
      );
      return 'disabled';
    }
    await this.client.sendMessage({
      chatId: target.chatId,
      text: buildAlertText(alert),
      messageThreadId: target.alertsThreadId,
    });
    return 'sent';
  }
}

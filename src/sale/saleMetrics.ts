/**
 * Safe UX metrics per sale operation (HOTFIX 2, Part C).
 *
 * One small counter set per `operationId`: card sends/edits, callbacks,
 * turns, backs, corrections, retries, recoveries, parse-vs-Gemini
 * attribution (deterministic-only vs scoped-interpreter turns),
 * outcome + approximate duration. NEVER raw messages, passwords, PINs,
 * wa.me URLs, credentials, or full phones — keys are operation ids and
 * counters only, safe for logs and audit metadata.
 *
 * In-memory and bounded (latest 200 operations): operational telemetry,
 * never persistence. The draft store stays the source of truth.
 */

export type SaleMetricEvent =
  | 'turn'
  | 'send'
  | 'edit'
  | 'resend'
  | 'callback'
  | 'back'
  | 'correction'
  | 'retry'
  | 'recovery'
  | 'parse_only'
  | 'gemini assist';

export type SaleOutcome = 'confirmed' | 'cancelled' | 'open' | 'error';

export interface SaleOperationMetrics {
  operationId: string;
  turns: number;
  sends: number;
  edits: number;
  resends: number;
  callbacks: number;
  backs: number;
  corrections: number;
  retries: number;
  recoveries: number;
  /** Turns resolved deterministically (zero Gemini). */
  parseOnly: number;
  /** Turns that used the scoped remainder interpreter. */
  geminiAssisted: number;
  outcome: SaleOutcome;
  startedAt: string;
  endedAt?: string;
}

const MAX_OPERATIONS = 200;

function blank(operationId: string): SaleOperationMetrics {
  return {
    operationId,
    turns: 0,
    sends: 0,
    edits: 0,
    resends: 0,
    callbacks: 0,
    backs: 0,
    corrections: 0,
    retries: 0,
    recoveries: 0,
    parseOnly: 0,
    geminiAssisted: 0,
    outcome: 'open',
    startedAt: new Date().toISOString(),
  };
}

export class SaleMetrics {
  private readonly operations = new Map<string, SaleOperationMetrics>();

  record(operationId: string, event: SaleMetricEvent): SaleOperationMetrics {
    let metrics = this.operations.get(operationId);
    if (metrics === undefined) {
      metrics = blank(operationId);
      this.operations.set(operationId, metrics);
      while (this.operations.size > MAX_OPERATIONS) {
        const oldest = this.operations.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.operations.delete(oldest);
      }
    }
    switch (event) {
      case 'turn':
        metrics.turns += 1;
        break;
      case 'send':
        metrics.sends += 1;
        break;
      case 'edit':
        metrics.edits += 1;
        break;
      case 'resend':
        metrics.resends += 1;
        break;
      case 'callback':
        metrics.callbacks += 1;
        break;
      case 'back':
        metrics.backs += 1;
        break;
      case 'correction':
        metrics.corrections += 1;
        break;
      case 'retry':
        metrics.retries += 1;
        break;
      case 'recovery':
        metrics.recoveries += 1;
        break;
      case 'parse_only':
        metrics.parseOnly += 1;
        break;
      case 'gemini assist':
        metrics.geminiAssisted += 1;
        break;
    }
    return metrics;
  }

  finish(operationId: string, outcome: SaleOutcome): SaleOperationMetrics {
    const metrics = this.record(operationId, 'turn');
    metrics.turns -= 1;
    metrics.outcome = outcome;
    metrics.endedAt = new Date().toISOString();
    return metrics;
  }

  get(operationId: string): SaleOperationMetrics | undefined {
    return this.operations.get(operationId);
  }

  /** Approximate duration in ms (null when the operation is still open). */
  durationMs(operationId: string): number | null {
    const metrics = this.operations.get(operationId);
    if (metrics === undefined || metrics.endedAt === undefined) {
      return null;
    }
    return Date.parse(metrics.endedAt) - Date.parse(metrics.startedAt);
  }
}

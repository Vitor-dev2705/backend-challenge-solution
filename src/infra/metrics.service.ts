import { Injectable } from '@nestjs/common';

const LATENCY_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly transactionStatuses = new Map<string, number>();
  private readonly latencyBuckets = new Map<number, number>(LATENCY_BUCKETS_MS.map(bucket => [bucket, 0]));
  private latencyCount = 0;
  private latencySumMs = 0;
  private outboxOldestPendingSeconds = 0;

  recordTransaction(status: string, durationMs: number): void {
    this.transactionStatuses.set(status, (this.transactionStatuses.get(status) ?? 0) + 1);
    this.latencyCount += 1;
    this.latencySumMs += durationMs;
    for (const bucket of LATENCY_BUCKETS_MS) {
      if (durationMs <= bucket) this.latencyBuckets.set(bucket, this.latencyBuckets.get(bucket)! + 1);
    }

  }

  recordDuplicate(): void { this.increment('wager_duplicates_total'); }
  recordRetry(): void { this.increment('message_retries_total'); }
  recordDeadLetter(): void { this.increment('messages_dead_lettered_total'); }
  recordLockConflict(): void { this.increment('database_lock_conflicts_total'); }
  setOutboxOldestPendingSeconds(seconds: number): void { this.outboxOldestPendingSeconds = Math.max(0, seconds); }

  render(): string {
    const lines = [
      '# TYPE wager_transactions_total counter',
      ...[...this.transactionStatuses.entries()].map(([status, value]) => `wager_transactions_total{status="${status}"} ${value}`),
      '# TYPE wager_duplicates_total counter',
      `wager_duplicates_total ${this.counters.get('wager_duplicates_total') ?? 0}`,
      '# TYPE message_retries_total counter',
      `message_retries_total ${this.counters.get('message_retries_total') ?? 0}`,
      '# TYPE messages_dead_lettered_total counter',
      `messages_dead_lettered_total ${this.counters.get('messages_dead_lettered_total') ?? 0}`,
      '# TYPE database_lock_conflicts_total counter',
      `database_lock_conflicts_total ${this.counters.get('database_lock_conflicts_total') ?? 0}`,
      '# TYPE wager_processing_duration_ms histogram',
      ...LATENCY_BUCKETS_MS.map(bucket => `wager_processing_duration_ms_bucket{le="${bucket}"} ${this.latencyBuckets.get(bucket)}`),
      `wager_processing_duration_ms_bucket{le="+Inf"} ${this.latencyCount}`,
      `wager_processing_duration_ms_sum ${this.latencySumMs}`,
      `wager_processing_duration_ms_count ${this.latencyCount}`,
      '# TYPE outbox_oldest_pending_seconds gauge',
      `outbox_oldest_pending_seconds ${this.outboxOldestPendingSeconds}`
    ];
    return `${lines.join('\n')}\n`;
  }

  private increment(metric: string): void {
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + 1);
  }
}

export const metrics = new MetricsService();

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { DataSource } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OutboxEntity } from './entities/outbox.entity';
import { metrics } from './metrics.service';
import { queryRows } from './query-result';
import { WageringService } from '../application/wagering.service';
import { CreateWagerDto } from '../http/dto/create-wager.dto';

class PermanentMessageError extends Error {}

const TERMINAL_BUSINESS_ERRORS = new Set([
  'INVALID_MONEY_AMOUNT', 'INVALID_CURRENCY', 'INVALID_TRANSACTION_AMOUNT', 'INVALID_INITIAL_BALANCE',
  'IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_KEY_INVALID', 'REFERENCE_REQUIRED', 'IDEMPOTENCY_CONFLICT',
  'WALLET_ALREADY_EXISTS', 'WALLET_NOT_FOUND', 'TRANSACTION_NOT_FOUND', 'CURRENCY_MISMATCH',
  'REFERENCE_NOT_PROCESSED', 'REFERENCE_SCOPE_MISMATCH', 'INVALID_WIN_REFERENCE',
  'INVALID_REFUND_REFERENCE', 'INVALID_ROLLBACK_REFERENCE', 'REFERENCE_AMOUNT_MISMATCH',
  'REFERENCE_ALREADY_REVERSED', 'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_OVERDRAW'
]);

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]*$/.test(error.message)) return error.message;
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}

@Injectable()
export class SqsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsService.name);
  private readonly client = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1', endpoint: process.env.SQS_ENDPOINT || undefined, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' } });
  private running = false;
  private outboxTimer?: ReturnType<typeof setInterval>;
  private referenceTimer?: ReturnType<typeof setInterval>;
  private consumerPromise?: Promise<void>;
  private readonly activePublishers = new Set<Promise<void>>();
  constructor(private readonly dataSource: DataSource, private readonly wagering: WageringService) {}
  onModuleInit() {
    this.running = true;
    this.outboxTimer = setInterval(() => {
      const publisher = this.publishOutbox()
        .catch(error => this.logger.error(JSON.stringify({ event: 'outbox_poll_failed', correlationId: null, messageId: null, transactionId: null, walletId: null, providerId: null, error: safeErrorCode(error) })))
        .finally(() => this.activePublishers.delete(publisher));
      this.activePublishers.add(publisher);
    }, 1000);
    this.referenceTimer = setInterval(() => {
      void this.wagering.reprocessPendingReferences().catch(error => this.logger.error(JSON.stringify({ event: 'reference_reprocess_failed', correlationId: null, messageId: null, transactionId: null, walletId: null, providerId: null, error: safeErrorCode(error) })));
    }, 1000);
    this.consumerPromise = this.consume();
  }
  async onModuleDestroy() { this.running = false; if (this.outboxTimer) clearInterval(this.outboxTimer); if (this.referenceTimer) clearInterval(this.referenceTimer); await Promise.all([this.consumerPromise, ...this.activePublishers]); this.client.destroy(); }

  async publishOutbox() {
    const queueUrl = process.env.SQS_EVENT_QUEUE_URL; if (!queueUrl || !this.dataSource.isInitialized) return;
    const [{ lag_seconds: lagSeconds }] = await this.dataSource.query(`SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))), 0) AS lag_seconds FROM outbox_messages WHERE published_at IS NULL`);
    metrics.setOutboxOldestPendingSeconds(Number(lagSeconds));
    const claimed = queryRows<{ id: string; payload: Record<string, unknown>; event_type: string; attempts: number }>(
      await this.dataSource.transaction(async manager => manager.query(`WITH batch AS (SELECT id FROM outbox_messages WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY occurred_at FOR UPDATE SKIP LOCKED LIMIT 20) UPDATE outbox_messages o SET next_attempt_at = now() + interval '60 seconds', attempts = attempts + 1 FROM batch WHERE o.id=batch.id RETURNING o.id,o.payload,o.event_type,o.attempts`))
    );
    for (const row of claimed) {
      try {
        await this.client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(row.payload), MessageGroupId: String(row.payload.aggregateId ?? row.id), MessageDeduplicationId: row.id }));
        await this.dataSource.getRepository(OutboxEntity).update({ id: row.id }, { publishedAt: new Date(), nextAttemptAt: null });
      } catch (error) {
        const delay = Math.min(300, 2 ** Math.min(8, row.attempts));
        metrics.recordRetry();
        await this.dataSource.getRepository(OutboxEntity).update({ id: row.id }, { nextAttemptAt: new Date(Date.now() + delay * 1000) });
        const payload = row.payload as { correlationId?: unknown; data?: { transactionId?: unknown; walletId?: unknown; providerId?: unknown } };
        this.logger.error(JSON.stringify({
          event: 'outbox_publish_failed',
          correlationId: typeof payload.correlationId === 'string' ? payload.correlationId : null,
          messageId: null,
          transactionId: typeof payload.data?.transactionId === 'string' ? payload.data.transactionId : row.id,
          walletId: typeof payload.data?.walletId === 'string' ? payload.data.walletId : row.payload.aggregateId,
          providerId: typeof payload.data?.providerId === 'string' ? payload.data.providerId : null,
          eventId: row.id,
          error: safeErrorCode(error)
        }));
      }
    }
  }

  private async consume() {
    const queueUrl = process.env.SQS_QUEUE_URL; if (!queueUrl) return;
    while (this.running) {
      try {
        const result = await this.client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 10, VisibilityTimeout: 30, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }));
        for (const message of result.Messages ?? []) {
          if (!message.Body || !message.ReceiptHandle || !message.MessageId) continue;
          let envelope: { messageId?: string; type?: string; correlationId?: string; data?: Record<string, unknown> } | undefined;
          try {
            try {
              envelope = JSON.parse(message.Body) as { messageId?: string; type?: string; correlationId?: string; data?: Record<string, unknown> };
            } catch {
              throw new PermanentMessageError('INVALID_MESSAGE_JSON');
            }
            const digest = createHash('sha256').update(message.Body).digest('hex');
            if (envelope.type === 'WagerTransactionRequested') {
              if (!envelope.data || typeof envelope.data !== 'object') throw new PermanentMessageError('INVALID_MESSAGE_PAYLOAD');
              const { idempotencyKey, ...payload } = envelope.data;
              if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') throw new PermanentMessageError('INVALID_IDEMPOTENCY_KEY');
              const data = plainToInstance(CreateWagerDto, payload);
              const errors = await validate(data, { whitelist: true, forbidNonWhitelisted: true });
              if (errors.length > 0) throw new PermanentMessageError('INVALID_MESSAGE_PAYLOAD');
              const key = typeof idempotencyKey === 'string' ? idempotencyKey : `${data.providerId}:${data.externalTransactionId}`;
              try {
                await this.wagering.submit(data, key, { consumerName: 'wager-transaction-consumer-v1', messageId: message.MessageId, payloadHash: digest, correlationId: envelope.correlationId });
              } catch (error) {
                if (error instanceof Error && TERMINAL_BUSINESS_ERRORS.has(error.message)) {
                  this.logger.warn(JSON.stringify({ event: 'sqs_business_rejection', correlationId: envelope.correlationId ?? null, messageId: message.MessageId, transactionId: data.externalTransactionId, providerId: data.providerId, walletId: data.walletId, code: error.message }));
                } else {
                  throw error;
                }
              }
            } else throw new PermanentMessageError('UNSUPPORTED_MESSAGE_TYPE');
            await this.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
          } catch (error) {
            const errorCode = safeErrorCode(error);
            const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
            if (error instanceof PermanentMessageError || receiveCount >= this.maxReceiveCount()) {
              await this.moveToDlq(message.Body, message.MessageId, message.ReceiptHandle, queueUrl, errorCode, receiveCount, envelope);
              continue;
            }
            const delay = Math.min(300, 2 ** Math.min(receiveCount, 8));
            metrics.recordRetry();
            this.logger.error(JSON.stringify({ event: 'sqs_consume_retry', correlationId: envelope?.correlationId ?? null, messageId: message.MessageId, type: envelope?.type, transactionId: envelope?.data?.externalTransactionId, walletId: envelope?.data?.walletId, providerId: envelope?.data?.providerId, error: errorCode, receiveCount, delaySeconds: delay }));
            await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: delay }));
          }
        }
      } catch (error) {
        this.logger.error(JSON.stringify({ event: 'sqs_poll_failed', correlationId: null, messageId: null, transactionId: null, walletId: null, providerId: null, error: safeErrorCode(error) }));
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  private maxReceiveCount(): number {
    const configured = Number(process.env.SQS_MAX_RECEIVE_COUNT ?? '5');
    if (!Number.isInteger(configured) || configured < 1) throw new Error('SQS_MAX_RECEIVE_COUNT must be a positive integer');
    return configured;
  }
  private async moveToDlq(body: string, messageId: string, receiptHandle: string, sourceQueueUrl: string, reason: string, receiveCount: number, envelope?: { correlationId?: string; data?: Record<string, unknown> }) {
    const deadLetterQueueUrl = process.env.SQS_DLQ_URL;
    if (!deadLetterQueueUrl) {
      this.logger.error(JSON.stringify({ event: 'sqs_dlq_unconfigured', correlationId: envelope?.correlationId ?? null, messageId, transactionId: envelope?.data?.externalTransactionId ?? null, walletId: envelope?.data?.walletId ?? null, providerId: envelope?.data?.providerId ?? null, reason }));
      await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: sourceQueueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: 60 }));
      return;
    }
    await this.client.send(new SendMessageCommand({
      QueueUrl: deadLetterQueueUrl,
      MessageBody: body,
      MessageGroupId: messageId.slice(0, 128),
      MessageDeduplicationId: `${messageId}-${receiveCount}-${randomUUID()}`.slice(0, 128)
    }));
    await this.client.send(new DeleteMessageCommand({ QueueUrl: sourceQueueUrl, ReceiptHandle: receiptHandle }));
    metrics.recordDeadLetter();
    this.logger.error(JSON.stringify({ event: 'sqs_message_dead_lettered', correlationId: envelope?.correlationId ?? null, messageId, transactionId: envelope?.data?.externalTransactionId ?? null, walletId: envelope?.data?.walletId ?? null, providerId: envelope?.data?.providerId ?? null, reason, receiveCount }));
  }
  async checkReady(): Promise<boolean> {
    try { await this.client.send(new ReceiveMessageCommand({ QueueUrl: process.env.SQS_QUEUE_URL, MaxNumberOfMessages: 1, WaitTimeSeconds: 0, VisibilityTimeout: 1 })); return true; } catch { return false; }
  }
}

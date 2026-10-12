import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { SQSClient, CreateQueueCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DataSource } from 'typeorm';
import { WageringService } from '../src/application/wagering.service';
import { InboxEntity } from '../src/infra/entities/inbox.entity';
import { LedgerEntity } from '../src/infra/entities/ledger.entity';
import { OutboxEntity } from '../src/infra/entities/outbox.entity';
import { WagerTransactionEntity } from '../src/infra/entities/wager-transaction.entity';
import { WalletEntity } from '../src/infra/entities/wallet.entity';
import { InitialSchema1710000000000 } from '../src/infra/migrations/1710000000000-InitialSchema';
import { PendingReferenceRetries1710000001000 } from '../src/infra/migrations/1710000001000-PendingReferenceRetries';
import { ProcessedReversalIndex1710000002000 } from '../src/infra/migrations/1710000002000-ProcessedReversalIndex';
import { SqsService } from '../src/infra/sqs.service';
import { CreateWagerDto } from '../src/http/dto/create-wager.dto';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a dedicated PostgreSQL database before running integration tests.');
if (!new URL(databaseUrl).pathname.toLowerCase().includes('test')) {
  throw new Error('TEST_DATABASE_URL must target a database whose name contains "test".');
}

const entities = [WalletEntity, WagerTransactionEntity, LedgerEntity, InboxEntity, OutboxEntity];
const migrations = [InitialSchema1710000000000, PendingReferenceRetries1710000001000, ProcessedReversalIndex1710000002000];
const dataSources = [0, 1, 2].map(() => new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities,
  migrations,
  synchronize: false,
  logging: false,
  extra: { max: 20 }
}));
const services = dataSources.map(source => new WageringService(source));
const sqsEndpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const eventQueueName = 'wager-events-integration.fifo';
const sourceQueueName = 'wager-transactions-integration.fifo';
const deadLetterQueueName = 'wager-transactions-dlq-integration.fifo';
let eventQueueUrl = '';
let sourceQueueUrl = '';
let deadLetterQueueUrl = '';
const sqsClient = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: sqsEndpoint,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test'
  }
});

function wager(walletId: string, playerId: string, fields: Partial<CreateWagerDto> = {}): CreateWagerDto {
  return {
    providerId: 'integration-provider',
    externalTransactionId: randomUUID(),
    playerId,
    walletId,
    roundId: 'integration-round',
    gameId: 'integration-game',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...fields
  };
}

function submitInSeparateProcess(dto: CreateWagerDto, idempotencyKey: string): Promise<{ status: string; failureCode?: string }> {
  return (async () => {
    const workerPath = resolve(__dirname, 'wagering-worker.ts');
    const child = Bun.spawn([process.execPath, workerPath], {
      env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    });
    child.stdin.write(JSON.stringify({ dto, idempotencyKey }));
    child.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]);
    if (exitCode !== 0) throw new Error(`Wager worker exited with code ${exitCode}: ${stderr}`);
    const resultLine = stdout.split(/\r?\n/).reverse().find(line => line.startsWith('WORKER_RESULT:'));
    if (!resultLine) throw new Error(`Wager worker did not return a result: ${stderr}`);
    return JSON.parse(resultLine.slice('WORKER_RESULT:'.length)) as { status: string; failureCode?: string };
  })();
}

describe('PostgreSQL and LocalStack wagering integration', () => {
  beforeAll(async () => {
    for (const source of dataSources) await source.initialize();
    await dataSources[0]!.runMigrations();
    eventQueueUrl = (await sqsClient.send(new CreateQueueCommand({
      QueueName: eventQueueName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' }
    }))).QueueUrl!;
    sourceQueueUrl = (await sqsClient.send(new CreateQueueCommand({
      QueueName: sourceQueueName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true', VisibilityTimeout: '30' }
    }))).QueueUrl!;
    deadLetterQueueUrl = (await sqsClient.send(new CreateQueueCommand({
      QueueName: deadLetterQueueName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' }
    }))).QueueUrl!;
    process.env.SQS_EVENT_QUEUE_URL = eventQueueUrl;
    process.env.SQS_QUEUE_URL = sourceQueueUrl;
    process.env.SQS_DLQ_URL = deadLetterQueueUrl;
    process.env.SQS_MAX_RECEIVE_COUNT = '5';
  }, 60_000);

  afterAll(async () => {
    await Promise.all(dataSources.map(source => source.destroy()));
    sqsClient.destroy();
  }, 30_000);

  test('deduplicates 50 parallel requests across three database instances', async () => {
    const playerId = randomUUID();
    const wallet = await services[0]!.createWallet(playerId, { amount: '1000.00', currency: 'BRL' });
    const request = wager(wallet.id, playerId, { externalTransactionId: randomUUID() });
    const key = `${request.providerId}:${request.externalTransactionId}`;

    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) =>
      services[index % services.length]!.submit(request, key)
    ));
    expect(responses.every(response => response.status === 'PROCESSED')).toBe(true);
    expect(responses.filter(response => 'idempotentReplay' in response && !response.idempotentReplay)).toHaveLength(1);
    expect((await dataSources[0]!.getRepository(LedgerEntity).find({ where: { walletId: wallet.id } })).filter(entry => entry.direction === 'DEBIT')).toHaveLength(1);
    expect((await services[1]!.getWallet(wallet.id)).balance.amount).toBe('990.00');

    const conflict = { ...request, money: { amount: '11.00', currency: 'BRL' } };
    await expect(services[2]!.submit(conflict, key)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  }, 60_000);

  test('serializes concurrent overspend and preserves balance-ledger equality', async () => {
    const playerId = randomUUID();
    const wallet = await services[0]!.createWallet(playerId, { amount: '100.00', currency: 'BRL' });
    const first = wager(wallet.id, playerId, { externalTransactionId: randomUUID(), money: { amount: '80.00', currency: 'BRL' } });
    const second = wager(wallet.id, playerId, { externalTransactionId: randomUUID(), money: { amount: '80.00', currency: 'BRL' } });
    const responses = await Promise.all([
      services[0]!.submit(first, `key-${first.externalTransactionId}`),
      services[1]!.submit(second, `key-${second.externalTransactionId}`)
    ]);

    expect(responses.filter(response => response.status === 'PROCESSED')).toHaveLength(1);
    expect(responses.filter(response => response.status === 'REJECTED' && 'failureCode' in response && response.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);
    expect((await services[2]!.getWallet(wallet.id)).balance.amount).toBe('20.00');
    expect((await dataSources[2]!.getRepository(LedgerEntity).find({ where: { walletId: wallet.id, direction: 'DEBIT' } }))).toHaveLength(1);
    expect((await services[2]!.reconcile(wallet.id)).consistent).toBe(true);
  }, 30_000);

  test('enforces wallet uniqueness, nonnegative balances and ledger immutability in PostgreSQL', async () => {
    const playerId = randomUUID();
    const wallet = await services[0]!.createWallet(playerId, { amount: '5.00', currency: 'BRL' });
    await expect(services[1]!.createWallet(playerId, { amount: '0.00', currency: 'BRL' })).rejects.toThrow('WALLET_ALREADY_EXISTS');
    await expect(dataSources[0]!.query('UPDATE wallets SET balance = -1 WHERE id = $1', [wallet.id])).rejects.toThrow();

    const bet = wager(wallet.id, playerId, { money: { amount: '1.00', currency: 'BRL' } });
    await services[1]!.submit(bet, `constraint-${bet.externalTransactionId}`);
    const entry = await dataSources[0]!.getRepository(LedgerEntity).findOneByOrFail({ transactionId: (await dataSources[0]!.getRepository(WagerTransactionEntity).findOneByOrFail({ providerId: bet.providerId, externalTransactionId: bet.externalTransactionId })).id });
    await expect(dataSources[2]!.query('UPDATE wallet_ledger_entries SET amount = 0 WHERE id = $1', [entry.id])).rejects.toThrow('ledger entries are immutable');
  }, 30_000);

  test('keeps the wallet correct with three independent application processes', async () => {
    const playerId = randomUUID();
    const wallet = await services[0]!.createWallet(playerId, { amount: '100.00', currency: 'BRL' });
    const requests = Array.from({ length: 3 }, () => {
      const dto = wager(wallet.id, playerId, {
        externalTransactionId: randomUUID(),
        money: { amount: '80.00', currency: 'BRL' }
      });
      return submitInSeparateProcess(dto, `process-${dto.externalTransactionId}`);
    });
    const results = await Promise.all(requests);
    expect(results.filter(result => result.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter(result => result.status === 'REJECTED' && result.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(2);
    expect((await services[0]!.getWallet(wallet.id)).balance.amount).toBe('20.00');
    expect((await services[1]!.reconcile(wallet.id)).consistent).toBe(true);
  }, 30_000);

  test('applies WIN, LOSS, REFUND and ROLLBACK rules with audit-safe rejections', async () => {
    const playerId = randomUUID();
    const wallet = await services[0]!.createWallet(playerId, { amount: '20.00', currency: 'BRL' });
    const bet = wager(wallet.id, playerId, { money: { amount: '10.00', currency: 'BRL' } });
    await services[0]!.submit(bet, `key-${bet.externalTransactionId}`);

    const refund = wager(wallet.id, playerId, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
      money: { amount: '10.00', currency: 'BRL' }
    });
    await services[1]!.submit(refund, `key-${refund.externalTransactionId}`);
    const duplicateRefund = wager(wallet.id, playerId, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
      money: { amount: '10.00', currency: 'BRL' }
    });
    const duplicateRefundResponse = await services[2]!.submit(duplicateRefund, `key-${duplicateRefund.externalTransactionId}`);
    expect('failureCode' in duplicateRefundResponse ? duplicateRefundResponse.failureCode : undefined).toBe('REFERENCE_ALREADY_REVERSED');

    const loss = wager(wallet.id, playerId, { kind: 'LOSS', money: { amount: '5.00', currency: 'BRL' } });
    await services[0]!.submit(loss, `key-${loss.externalTransactionId}`);
    const referencedWin = wager(wallet.id, playerId, {
      kind: 'WIN',
      referenceExternalTransactionId: bet.externalTransactionId,
      money: { amount: '5.00', currency: 'BRL' }
    });
    await services[1]!.submit(referencedWin, `key-${referencedWin.externalTransactionId}`);
    const rollbackWin = wager(wallet.id, playerId, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: referencedWin.externalTransactionId,
      money: { amount: '5.00', currency: 'BRL' }
    });
    await services[2]!.submit(rollbackWin, `key-${rollbackWin.externalTransactionId}`);

    const secondWin = wager(wallet.id, playerId, { kind: 'WIN', money: { amount: '5.00', currency: 'BRL' } });
    await services[0]!.submit(secondWin, `key-${secondWin.externalTransactionId}`);
    const drainingBet = wager(wallet.id, playerId, { money: { amount: '25.00', currency: 'BRL' } });
    await services[1]!.submit(drainingBet, `key-${drainingBet.externalTransactionId}`);
    const overdrawRollback = wager(wallet.id, playerId, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: secondWin.externalTransactionId,
      money: { amount: '5.00', currency: 'BRL' }
    });
    const overdrawResponse = await services[2]!.submit(overdrawRollback, `key-${overdrawRollback.externalTransactionId}`);
    expect('failureCode' in overdrawResponse ? overdrawResponse.failureCode : undefined).toBe('REVERSAL_WOULD_OVERDRAW');

    expect((await services[0]!.getWallet(wallet.id)).balance.amount).toBe('0.00');
    expect((await services[1]!.reconcile(wallet.id)).consistent).toBe(true);
    expect(await dataSources[2]!.getRepository(LedgerEntity).countBy({ walletId: wallet.id })).toBe(7);
    const firstPage = await services[0]!.ledger(wallet.id, 1);
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await services[1]!.ledger(wallet.id, 1, firstPage.nextCursor!);
    expect(secondPage.items[0]!.id).not.toBe(firstPage.items[0]!.id);
    await expect(services[2]!.ledger(wallet.id, 20, 'invalid-cursor')).rejects.toThrow('INVALID_CURSOR');
  }, 30_000);

  test('reprocesses a durable pending refund after its reference arrives', async () => {
    const playerId = randomUUID();
    const wallet = await services[0]!.createWallet(playerId, { amount: '100.00', currency: 'BRL' });
    const betId = randomUUID();
    const refund = wager(wallet.id, playerId, {
      externalTransactionId: randomUUID(),
      kind: 'REFUND',
      referenceExternalTransactionId: betId,
      money: { amount: '10.00', currency: 'BRL' }
    });
    const pending = await services[0]!.submit(refund, `key-${refund.externalTransactionId}`);
    expect(pending.status).toBe('PENDING_REFERENCE');

    const bet = wager(wallet.id, playerId, {
      externalTransactionId: betId,
      money: { amount: '10.00', currency: 'BRL' }
    });
    await services[1]!.submit(bet, `key-${bet.externalTransactionId}`);
    await dataSources[0]!.query(`UPDATE wager_transactions SET reference_next_attempt_at = now() WHERE external_transaction_id = $1`, [refund.externalTransactionId]);
    expect(await services[2]!.reprocessPendingReferences()).toBeGreaterThan(0);
    expect((await services[0]!.getExternalTransaction(refund.providerId, refund.externalTransactionId)).status).toBe('PROCESSED');
    expect((await services[1]!.reconcile(wallet.id)).consistent).toBe(true);
  }, 30_000);

  test('commits inbox and financial records together and claims outbox across publishers', async () => {
    const playerId = randomUUID();
    const wallet = await services[0]!.createWallet(playerId, { amount: '50.00', currency: 'BRL' });
    const request = wager(wallet.id, playerId);
    const messageId = randomUUID();
    await services[1]!.submit(request, `key-${request.externalTransactionId}`, {
      consumerName: 'integration-consumer',
      messageId,
      payloadHash: 'a'.repeat(64)
    });
    expect(await services[2]!.submit(request, `key-${request.externalTransactionId}`, {
      consumerName: 'integration-consumer',
      messageId,
      payloadHash: 'a'.repeat(64)
    })).toEqual({ duplicateMessage: true, status: 'ALREADY_RECEIVED' });

    const inbox = await dataSources[2]!.getRepository(InboxEntity).findOneByOrFail({ consumerName: 'integration-consumer', messageId });
    expect(inbox.processedAt).toBeInstanceOf(Date);
    expect(await dataSources[2]!.getRepository(LedgerEntity).countBy({ transactionId: (await dataSources[2]!.getRepository(WagerTransactionEntity).findOneByOrFail({ externalTransactionId: request.externalTransactionId, providerId: request.providerId })).id })).toBe(1);

    const publishers = dataSources.slice(0, 2).map((source, index) => new SqsService(source, services[index]!));
    await dataSources[0]!.query(`UPDATE outbox_messages SET next_attempt_at = NULL WHERE published_at IS NULL`);
    let [{ count: pending }] = await dataSources[0]!.query(`SELECT count(*)::integer AS count FROM outbox_messages WHERE published_at IS NULL`);
    for (let attempt = 0; pending > 0 && attempt < 10; attempt += 1) {
      await Promise.all(publishers.map(publisher => publisher.publishOutbox()));
      [{ count: pending }] = await dataSources[0]!.query(`SELECT count(*)::integer AS count FROM outbox_messages WHERE published_at IS NULL`);
    }
    expect(pending).toBe(0);

    const messages = await sqsClient.send(new ReceiveMessageCommand({
      QueueUrl: eventQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1
    }));
    expect((messages.Messages ?? []).length).toBeGreaterThan(0);
  }, 30_000);

  test('consumes real SQS messages, deduplicates redelivery and moves malformed input to DLQ', async () => {
    const playerId = randomUUID();
    const wallet = await services[0]!.createWallet(playerId, { amount: '25.00', currency: 'BRL' });
    const request = wager(wallet.id, playerId);
    const idempotencyKey = `sqs-${request.externalTransactionId}`;
    const body = JSON.stringify({
      messageId: randomUUID(),
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...request, idempotencyKey }
    });
    const first = await sqsClient.send(new SendMessageCommand({
      QueueUrl: sourceQueueUrl,
      MessageBody: body,
      MessageGroupId: wallet.id,
      MessageDeduplicationId: randomUUID()
    }));
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: sourceQueueUrl,
      MessageBody: body,
      MessageGroupId: wallet.id,
      MessageDeduplicationId: randomUUID()
    }));
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: sourceQueueUrl,
      MessageBody: '{',
      MessageGroupId: wallet.id,
      MessageDeduplicationId: randomUUID()
    }));

    const worker = new SqsService(dataSources[2]!, services[2]!);
    worker.onModuleInit();
    try {
      const deadline = Date.now() + 15_000;
      let transaction;
      let foundDeadLetter = false;
      while (Date.now() < deadline) {
        transaction = await dataSources[0]!.getRepository(WagerTransactionEntity).findOne({
          where: { providerId: request.providerId, externalTransactionId: request.externalTransactionId }
        });
        const dlq = await sqsClient.send(new ReceiveMessageCommand({
          QueueUrl: deadLetterQueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1
        }));
        foundDeadLetter ||= (dlq.Messages ?? []).some(message => message.Body === '{');
        if (transaction?.status === 'PROCESSED' && foundDeadLetter) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(transaction?.status).toBe('PROCESSED');
      expect(foundDeadLetter).toBe(true);
      expect(await dataSources[0]!.getRepository(LedgerEntity).countBy({ walletId: wallet.id, direction: 'DEBIT' })).toBe(1);
      const inboxMessages = await dataSources[0]!.query(
        `SELECT count(*)::integer AS count FROM inbox_messages WHERE consumer_name = $1 AND message_id = ANY($2::varchar[])`,
        ['wager-transaction-consumer-v1', [first.MessageId]]
      );
      expect(inboxMessages[0].count).toBe(1);
    } finally {
      await worker.onModuleDestroy();
    }
  }, 30_000);
});

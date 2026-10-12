import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { Money } from '../domain/money';
import { WalletEntity } from '../infra/entities/wallet.entity';
import { WagerTransactionEntity } from '../infra/entities/wager-transaction.entity';
import { LedgerEntity } from '../infra/entities/ledger.entity';
import { OutboxEntity } from '../infra/entities/outbox.entity';
import { InboxEntity } from '../infra/entities/inbox.entity';
import { metrics } from '../infra/metrics.service';
import { queryRows } from '../infra/query-result';
import { CreateWagerDto } from '../http/dto/create-wager.dto';

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
};
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
interface InboxContext { consumerName: string; messageId: string; payloadHash: string; correlationId?: string }

function postgresConstraint(error: unknown): { code: string; constraint: string } | undefined {
  if (typeof error !== 'object' || error === null || !('driverError' in error)) return undefined;
  const driverError = error.driverError;
  if (typeof driverError !== 'object' || driverError === null || !('code' in driverError) || !('constraint' in driverError)) return undefined;
  return typeof driverError.code === 'string' && typeof driverError.constraint === 'string'
    ? { code: driverError.code, constraint: driverError.constraint }
    : undefined;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]*$/.test(error.message)) return error.message;
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}

@Injectable()
export class WageringService {
  private readonly logger = new Logger(WageringService.name);
  constructor(private readonly dataSource: DataSource) {}

  async createWallet(playerId: string, initialBalance: { amount: string; currency: string }) {
    const money = Money.from(initialBalance); const id = randomUUID(); const now = new Date();
    try {
      return await this.dataSource.transaction(async manager => {
        const repo = manager.getRepository(WalletEntity);
        if (await repo.findOne({ where: { playerId, currency: money.currency } })) throw new Error('WALLET_ALREADY_EXISTS');
        const wallet = repo.create({ id, playerId, currency: money.currency, balance: money.toJSON().amount, version: 1 });
        await repo.save(wallet);
        if (money.isPositive()) {
          const openingId = randomUUID();
          const tx = manager.getRepository(WagerTransactionEntity).create({ id: openingId, providerId: 'internal', externalTransactionId: `opening:${id}`, idempotencyKey: `opening:${id}`, payloadHash: hash({ id, opening: money.toJSON() }), walletId: id, playerId, roundId: 'internal', gameId: 'internal', kind: 'OPENING', amount: money.toJSON().amount, currency: money.currency, referenceExternalTransactionId: null, referenceTransactionId: null, status: 'PROCESSED', failureCode: null, resultBalance: money.toJSON().amount, resultVersion: 1, processedAt: now });
          await manager.getRepository(WagerTransactionEntity).save(tx);
          await manager.getRepository(LedgerEntity).save(manager.getRepository(LedgerEntity).create({ id: randomUUID(), walletId: id, transactionId: openingId, direction: 'CREDIT', amount: money.toJSON().amount, currency: money.currency, balanceBefore: '0.00', balanceAfter: money.toJSON().amount }));
          await this.enqueue(manager, id, 'WalletBalanceChanged', { walletId: id, transactionId: openingId, direction: 'CREDIT', money: money.toJSON(), balanceBefore: { amount: '0.00', currency: money.currency }, balanceAfter: money.toJSON(), walletVersion: 1 });
        }
        return { id, playerId, balance: money.toJSON(), version: 1 };
      });
    } catch (error) {
      if (postgresConstraint(error)?.constraint === 'uq_wallet_player_currency') throw new Error('WALLET_ALREADY_EXISTS');
      throw error;
    }
  }

  async submit(dto: CreateWagerDto, idempotencyKey: string, inbox?: InboxContext, reprocessPendingReference = false) {
    const startedAt = Date.now();
    const correlationId = inbox?.correlationId ?? randomUUID();
    if (!idempotencyKey?.trim()) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    if (idempotencyKey.length > 255) throw new Error('IDEMPOTENCY_KEY_INVALID');
    if (dto.kind === 'REFUND' || dto.kind === 'ROLLBACK') if (!dto.referenceExternalTransactionId) throw new Error('REFERENCE_REQUIRED');
    const money = Money.from(dto.money);
    if (!money.isPositive()) throw new Error('INVALID_TRANSACTION_AMOUNT');
    const businessPayload = { providerId: dto.providerId, externalTransactionId: dto.externalTransactionId, playerId: dto.playerId, walletId: dto.walletId, roundId: dto.roundId, gameId: dto.gameId, kind: dto.kind, money: money.toJSON(), referenceExternalTransactionId: dto.referenceExternalTransactionId ?? null };
    const payloadHash = hash(businessPayload);
    try {
      const result = await this.dataSource.transaction('READ COMMITTED', async manager => {
        if (inbox) {
          const inserted = queryRows<{ message_id: string }>(await manager.query(`INSERT INTO inbox_messages(consumer_name,message_id,payload_hash,processed_at) VALUES ($1,$2,$3,NULL) ON CONFLICT DO NOTHING RETURNING message_id`, [inbox.consumerName, inbox.messageId, inbox.payloadHash]));
          if (inserted.length === 0) {
            const prior = await manager.getRepository(InboxEntity).findOne({ where: { consumerName: inbox.consumerName, messageId: inbox.messageId } });
            if (prior?.payloadHash !== inbox.payloadHash) throw new Error('INBOX_PAYLOAD_CONFLICT');
            metrics.recordDuplicate();
            return { duplicateMessage: true, status: 'ALREADY_RECEIVED' };
          }
        }
        const txRepo = manager.getRepository(WagerTransactionEntity);
        const existing = await txRepo.createQueryBuilder('t').setLock('pessimistic_write').where('t.idempotency_key = :key OR (t.provider_id = :provider AND t.external_transaction_id = :external)', { key: idempotencyKey, provider: dto.providerId, external: dto.externalTransactionId }).getOne();
        let entity: WagerTransactionEntity | undefined;
        if (existing) {
          if (existing.idempotencyKey !== idempotencyKey || existing.payloadHash !== payloadHash) throw new Error('IDEMPOTENCY_CONFLICT');
          if (existing.status !== 'PENDING_REFERENCE' || !reprocessPendingReference) {
            if (inbox) await manager.getRepository(InboxEntity).update({ consumerName: inbox.consumerName, messageId: inbox.messageId }, { processedAt: new Date() });
            return this.trackedResponse(existing, true, startedAt);
          }
          entity = existing;
        }
        const wallet = await manager.getRepository(WalletEntity).createQueryBuilder('w').setLock('pessimistic_write').where('w.id = :id', { id: dto.walletId }).getOne();
        if (!wallet || wallet.playerId !== dto.playerId) throw new Error('WALLET_NOT_FOUND');
        if (wallet.currency !== money.currency) throw new Error('CURRENCY_MISMATCH');
        if (!entity) {
          entity = txRepo.create({ id: randomUUID(), providerId: dto.providerId, externalTransactionId: dto.externalTransactionId, idempotencyKey, payloadHash, walletId: dto.walletId, playerId: dto.playerId, roundId: dto.roundId, gameId: dto.gameId, kind: dto.kind, amount: money.toJSON().amount, currency: money.currency, referenceExternalTransactionId: dto.referenceExternalTransactionId ?? null, referenceTransactionId: null, status: 'PENDING', failureCode: null, resultBalance: null, resultVersion: null, processedAt: null });
          await txRepo.save(entity);
        }
        if (dto.kind === 'REFUND' || dto.kind === 'ROLLBACK' || (dto.kind === 'WIN' && dto.referenceExternalTransactionId)) {
          const ref = await txRepo.findOne({ where: { providerId: dto.providerId, externalTransactionId: dto.referenceExternalTransactionId! } });
          if (!ref) {
            if (dto.kind === 'WIN') return this.reject(manager, entity, wallet, 'REFERENCE_NOT_FOUND', inbox, startedAt);
            if (entity.referenceAttempts >= 12) return this.reject(manager, entity, wallet, 'REFERENCE_NOT_FOUND', inbox, startedAt);
            const firstPendingAttempt = entity.status !== 'PENDING_REFERENCE';
            entity.status = 'PENDING_REFERENCE';
            entity.referenceNextAttemptAt ??= new Date(Date.now() + 2_000);
            await txRepo.save(entity);
            if (firstPendingAttempt) {
              await this.enqueue(manager, entity.id, 'WagerTransactionPendingReference', { transactionId: entity.id, providerId: dto.providerId, referenceExternalTransactionId: dto.referenceExternalTransactionId });
            }
            if (inbox) await manager.getRepository(InboxEntity).update({ consumerName: inbox.consumerName, messageId: inbox.messageId }, { processedAt: new Date() });
            return this.trackedResponse(entity, !firstPendingAttempt, startedAt);
          }
          if (ref.status === 'PENDING' || ref.status === 'PENDING_REFERENCE') {
            if (entity.referenceAttempts >= 12) return this.reject(manager, entity, wallet, 'REFERENCE_NOT_PROCESSED', inbox, startedAt);
            const firstPendingAttempt = entity.status !== 'PENDING_REFERENCE';
            entity.status = 'PENDING_REFERENCE';
            entity.referenceNextAttemptAt ??= new Date(Date.now() + 2_000);
            await txRepo.save(entity);
            if (firstPendingAttempt) {
              await this.enqueue(manager, entity.id, 'WagerTransactionPendingReference', { transactionId: entity.id, providerId: dto.providerId, referenceExternalTransactionId: dto.referenceExternalTransactionId });
            }
            if (inbox) await manager.getRepository(InboxEntity).update({ consumerName: inbox.consumerName, messageId: inbox.messageId }, { processedAt: new Date() });
            return this.trackedResponse(entity, !firstPendingAttempt, startedAt);
          }
          if (ref.status !== 'PROCESSED') return this.reject(manager, entity, wallet, 'REFERENCE_NOT_PROCESSED', inbox, startedAt);
          try {
            this.validateReference(dto, ref, money);
          } catch (error) {
            const code = error instanceof Error ? error.message : 'INVALID_REFERENCE';
            return this.reject(manager, entity, wallet, code, inbox, startedAt);
          }
          entity.referenceTransactionId = ref.id;
          entity.referenceNextAttemptAt = null;
          const reversal = await txRepo.findOne({ where: { providerId: dto.providerId, referenceTransactionId: ref.id, kind: dto.kind, status: 'PROCESSED' } });
          if (reversal) return this.reject(manager, entity, wallet, 'REFERENCE_ALREADY_REVERSED', inbox, startedAt);
        }
        if (dto.kind === 'BET' && Money.from({ amount: wallet.balance, currency: wallet.currency }).isLessThan(money)) return this.reject(manager, entity, wallet, 'INSUFFICIENT_FUNDS', inbox, startedAt);
        const before = Money.from({ amount: wallet.balance, currency: wallet.currency });
        let after = before; let direction: 'DEBIT'|'CREDIT'|null = null;
        if (dto.kind === 'BET') { after = before.subtract(money); direction = 'DEBIT'; }
        if (dto.kind === 'WIN' || dto.kind === 'REFUND') { after = before.add(money); direction = 'CREDIT'; }
        if (dto.kind === 'ROLLBACK') {
          const ref = await txRepo.findOneOrFail({ where: { id: entity.referenceTransactionId! } });
          const refMoney = Money.from({ amount: ref.amount, currency: ref.currency });
          if (ref.kind === 'BET') { after = before.add(refMoney); direction = 'CREDIT'; }
          else { if (before.isLessThan(refMoney)) return this.reject(manager, entity, wallet, 'REVERSAL_WOULD_OVERDRAW', inbox, startedAt); after = before.subtract(refMoney); direction = 'DEBIT'; }
        }
        // LOSS is a processed result with no balance movement or ledger entry.
        if (direction) {
          wallet.balance = after.toJSON().amount; wallet.version += 1; wallet.updatedAt = new Date(); await manager.getRepository(WalletEntity).save(wallet);
          await manager.getRepository(LedgerEntity).save(manager.getRepository(LedgerEntity).create({ id: randomUUID(), walletId: wallet.id, transactionId: entity.id, direction, amount: money.toJSON().amount, currency: money.currency, balanceBefore: before.toJSON().amount, balanceAfter: after.toJSON().amount }));
        }
        entity.status = 'PROCESSED'; entity.processedAt = new Date(); entity.resultBalance = after.toJSON().amount; entity.resultVersion = wallet.version; await txRepo.save(entity);
        await this.enqueue(manager, entity.id, 'WagerTransactionProcessed', { transactionId: entity.id, status: entity.status, walletId: wallet.id, balance: after.toJSON(), kind: dto.kind });
        if (direction) await this.enqueue(manager, wallet.id, 'WalletBalanceChanged', { walletId: wallet.id, transactionId: entity.id, direction, money: money.toJSON(), balanceBefore: before.toJSON(), balanceAfter: after.toJSON(), walletVersion: wallet.version });
        if (inbox) await manager.getRepository(InboxEntity).update({ consumerName: inbox.consumerName, messageId: inbox.messageId }, { processedAt: new Date() });
        return this.trackedResponse(entity, false, startedAt);
      });
      this.logger.log(JSON.stringify({
        event: 'wager_transaction_result',
        correlationId,
        messageId: inbox?.messageId ?? null,
        transactionId: 'transactionId' in result ? result.transactionId : dto.externalTransactionId,
        walletId: dto.walletId,
        providerId: dto.providerId,
        status: result.status,
        idempotentReplay: 'idempotentReplay' in result ? result.idempotentReplay : true
      }));
      return result;
    } catch (error) {
      const constraint = postgresConstraint(error);
      if (constraint?.code === '40P01' || constraint?.code === '55P03' || constraint?.code === '40001') metrics.recordLockConflict();
      this.logger.error(JSON.stringify({
        event: 'wager_transaction_failure',
        correlationId,
        messageId: inbox?.messageId ?? null,
        transactionId: dto.externalTransactionId,
        walletId: dto.walletId,
        providerId: dto.providerId,
        error: safeErrorCode(error)
      }));
      if (constraint?.code === '23505' && ['uq_wager_idempotency_key', 'uq_wager_provider_external'].includes(constraint.constraint)) {
        const existing = await this.dataSource.getRepository(WagerTransactionEntity).findOne({
          where: [
            { idempotencyKey },
            { providerId: dto.providerId, externalTransactionId: dto.externalTransactionId }
          ]
        });
        if (existing?.idempotencyKey === idempotencyKey && existing.payloadHash === payloadHash) return this.trackedResponse(existing, true, startedAt);
        throw new Error('IDEMPOTENCY_CONFLICT');
      }
      throw error;
    }
  }

  async getWallet(id: string) {
    const wallet = await this.dataSource.getRepository(WalletEntity).findOne({ where: { id } });
    if (!wallet) throw new Error('WALLET_NOT_FOUND');
    return { id: wallet.id, playerId: wallet.playerId, balance: { amount: wallet.balance, currency: wallet.currency }, version: wallet.version };
  }
  async reprocessPendingReferences(): Promise<number> {
    if (!this.dataSource.isInitialized) return 0;
    const claimed = queryRows<{
      provider_id: string;
      external_transaction_id: string;
      idempotency_key: string;
      player_id: string;
      wallet_id: string;
      round_id: string;
      game_id: string;
      kind: CreateWagerDto['kind'];
      amount: string;
      currency: string;
      reference_external_transaction_id: string | null;
    }>(await this.dataSource.query(`WITH due AS (
      SELECT id
      FROM wager_transactions
      WHERE status = 'PENDING_REFERENCE'
        AND (reference_next_attempt_at IS NULL OR reference_next_attempt_at <= now())
      ORDER BY reference_next_attempt_at NULLS FIRST, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 20
    )
    UPDATE wager_transactions t
    SET reference_attempts = t.reference_attempts + 1,
        reference_next_attempt_at = now() + LEAST(300, power(2, LEAST(t.reference_attempts + 1, 8))) * interval '1 second'
    FROM due
    WHERE t.id = due.id
    RETURNING t.provider_id, t.external_transaction_id, t.idempotency_key, t.player_id,
      t.wallet_id, t.round_id, t.game_id, t.kind, t.amount, t.currency,
      t.reference_external_transaction_id`));
    for (const row of claimed) {
      metrics.recordRetry();
      await this.submit({
        providerId: row.provider_id,
        externalTransactionId: row.external_transaction_id,
        playerId: row.player_id,
        walletId: row.wallet_id,
        roundId: row.round_id,
        gameId: row.game_id,
        kind: row.kind,
        money: { amount: row.amount, currency: row.currency },
        referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined
      }, row.idempotency_key, undefined, true);
    }
    return claimed.length;
  }
  async getTransaction(id: string) {
    const tx = await this.dataSource.getRepository(WagerTransactionEntity).findOne({ where: { id } });
    if (!tx) throw new Error('TRANSACTION_NOT_FOUND'); return this.response(tx, false);
  }
  async getExternalTransaction(providerId: string, externalTransactionId: string) {
    const tx = await this.dataSource.getRepository(WagerTransactionEntity).findOne({ where: { providerId, externalTransactionId } });
    if (!tx) throw new Error('TRANSACTION_NOT_FOUND'); return this.response(tx, false);
  }
  async ledger(walletId: string, limit = 50, cursor?: string) {
    if (!Number.isInteger(limit) || !Number.isFinite(limit)) throw new Error('INVALID_LIMIT');
    const safeLimit = Math.max(1, Math.min(100, limit));
    const qb = this.dataSource.getRepository(LedgerEntity).createQueryBuilder('l').where('l.wallet_id = :walletId', { walletId }).orderBy('l.created_at', 'DESC').addOrderBy('l.id', 'DESC').take(safeLimit + 1);
    if (cursor) {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('INVALID_CURSOR');
      const decodedCursor = Buffer.from(cursor, 'base64url').toString('utf8');
      if (Buffer.from(decodedCursor, 'utf8').toString('base64url') !== cursor) throw new Error('INVALID_CURSOR');
      const [createdAt, id, ...extra] = decodedCursor.split('|');
      const timestamp = new Date(createdAt ?? '');
      if (extra.length > 0 || !createdAt || Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== createdAt || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? '')) throw new Error('INVALID_CURSOR');
      qb.andWhere('(l.created_at, l.id) < (:createdAt, :id)', { createdAt, id });
    }
    const rows = await qb.getMany(); const hasMore = rows.length > safeLimit; const entries = rows.slice(0, safeLimit);
    const last = entries.at(-1); return { items: entries.map(e => ({ id: e.id, walletId: e.walletId, transactionId: e.transactionId, direction: e.direction, money: { amount: e.amount, currency: e.currency }, balanceBefore: { amount: e.balanceBefore, currency: e.currency }, balanceAfter: { amount: e.balanceAfter, currency: e.currency }, createdAt: e.createdAt })), nextCursor: hasMore && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null };
  }
  async reconcile(walletId: string) {
    return this.dataSource.transaction(async manager => {
      const wallet = await manager.getRepository(WalletEntity).findOne({ where: { id: walletId } }); if (!wallet) throw new Error('WALLET_NOT_FOUND');
      const ledger = await manager.getRepository(LedgerEntity).find({ where: { walletId }, order: { createdAt: 'ASC', id: 'ASC' } });
      let calculated = Money.zero(wallet.currency);
      for (const entry of ledger) { const amount = Money.from({ amount: entry.amount, currency: entry.currency }); calculated = entry.direction === 'CREDIT' ? calculated.add(amount) : calculated.subtract(amount); }
      const stored = Money.from({ amount: wallet.balance, currency: wallet.currency }); const difference = stored.subtract(calculated);
      return { walletId, storedBalance: stored.toJSON(), calculatedBalance: calculated.toJSON(), difference: { amount: difference.toString().split(' ')[0], currency: wallet.currency }, consistent: stored.equals(calculated), checkedEntries: ledger.length };
    });
  }
  private validateReference(dto: CreateWagerDto, ref: WagerTransactionEntity, money: Money) {
    if (ref.status !== 'PROCESSED') throw new Error('REFERENCE_NOT_PROCESSED');
    if (ref.playerId !== dto.playerId || ref.walletId !== dto.walletId || ref.roundId !== dto.roundId || ref.currency !== money.currency) throw new Error('REFERENCE_SCOPE_MISMATCH');
    if (dto.kind === 'WIN' && ref.kind !== 'BET') throw new Error('INVALID_WIN_REFERENCE');
    if (dto.kind === 'REFUND' && ref.kind !== 'BET') throw new Error('INVALID_REFUND_REFERENCE');
    if (dto.kind === 'ROLLBACK' && !['BET','WIN','REFUND'].includes(ref.kind)) throw new Error('INVALID_ROLLBACK_REFERENCE');
    if ((dto.kind === 'REFUND' || dto.kind === 'ROLLBACK') && ref.amount !== money.toJSON().amount) throw new Error('REFERENCE_AMOUNT_MISMATCH');
  }
  private async reject(manager: EntityManager, tx: WagerTransactionEntity, wallet: WalletEntity, code: string, inbox: InboxContext | undefined, startedAt: number) {
    tx.status = 'REJECTED'; tx.failureCode = code; tx.processedAt = new Date(); tx.resultBalance = wallet.balance; tx.resultVersion = wallet.version;
    await manager.getRepository(WagerTransactionEntity).save(tx);
    await this.enqueue(manager, tx.id, 'WagerTransactionRejected', { transactionId: tx.id, walletId: wallet.id, failureCode: code });
    if (inbox) await manager.getRepository(InboxEntity).update({ consumerName: inbox.consumerName, messageId: inbox.messageId }, { processedAt: new Date() });
    metrics.recordTransaction('REJECTED', Date.now() - startedAt);
    return this.response(tx, false);
  }
  private trackedResponse(tx: WagerTransactionEntity, replay: boolean, startedAt: number) {
    if (replay) metrics.recordDuplicate();
    metrics.recordTransaction(tx.status, Date.now() - startedAt);
    return this.response(tx, replay);
  }
  private async enqueue(manager: EntityManager, aggregateId: string, eventType: string, data: Record<string, unknown>) {
    const event = { eventId: randomUUID(), eventType, aggregateId, correlationId: randomUUID(), occurredAt: new Date().toISOString(), version: 1, data };
    await manager.getRepository(OutboxEntity).save(manager.getRepository(OutboxEntity).create({ id: event.eventId, aggregateId, eventType, payload: event, attempts: 0, nextAttemptAt: null, publishedAt: null }));
  }
  private response(tx: WagerTransactionEntity, replay: boolean) {
    return { transactionId: tx.id, status: tx.status, balance: tx.resultBalance === null ? null : { amount: tx.resultBalance, currency: tx.currency }, failureCode: tx.failureCode, idempotentReplay: replay };
  }
}

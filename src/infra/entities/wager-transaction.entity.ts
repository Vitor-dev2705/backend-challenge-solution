import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
@Entity('wager_transactions')
@Index('uq_wager_idempotency_key', ['idempotencyKey'], { unique: true })
@Index('uq_wager_provider_external', ['providerId', 'externalTransactionId'], { unique: true })
@Index('ix_wager_pending_reference', ['status', 'createdAt'])
@Check('ck_wager_money_nonnegative', 'amount >= 0')
export class WagerTransactionEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'provider_id', type: 'varchar', length: 120 }) providerId!: string;
  @Column({ name: 'external_transaction_id', type: 'varchar', length: 200 }) externalTransactionId!: string;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 }) idempotencyKey!: string;
  @Column({ name: 'payload_hash', type: 'char', length: 64 }) payloadHash!: string;
  @Column({ name: 'wallet_id', type: 'uuid' }) walletId!: string;
  @Column({ name: 'player_id', type: 'uuid' }) playerId!: string;
  @Column({ name: 'round_id', type: 'varchar', length: 200 }) roundId!: string;
  @Column({ name: 'game_id', type: 'varchar', length: 200 }) gameId!: string;
  @Column({ type: 'varchar', length: 16 }) kind!: string;
  @Column({ type: 'numeric', precision: 20, scale: 2 }) amount!: string;
  @Column({ type: 'char', length: 3 }) currency!: string;
  @Column({ name: 'reference_external_transaction_id', type: 'varchar', length: 200, nullable: true }) referenceExternalTransactionId!: string | null;
  @Column({ name: 'reference_transaction_id', type: 'uuid', nullable: true }) referenceTransactionId!: string | null;
  @Column({ name: 'reference_attempts', type: 'integer', default: 0 }) referenceAttempts!: number;
  @Column({ name: 'reference_next_attempt_at', type: 'timestamptz', nullable: true }) referenceNextAttemptAt!: Date | null;
  @Column({ type: 'varchar', length: 24, default: 'PENDING' }) status!: string;
  @Column({ name: 'failure_code', type: 'varchar', length: 80, nullable: true }) failureCode!: string | null;
  @Column({ name: 'result_balance', type: 'numeric', precision: 20, scale: 2, nullable: true }) resultBalance!: string | null;
  @Column({ name: 'result_version', type: 'integer', nullable: true }) resultVersion!: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true }) processedAt!: Date | null;
}

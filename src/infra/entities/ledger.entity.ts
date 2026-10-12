import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
@Entity('wallet_ledger_entries')
@Index('uq_ledger_transaction_wallet', ['transactionId', 'walletId'], { unique: true })
@Index('ix_ledger_wallet_created', ['walletId', 'createdAt', 'id'])
@Check('ck_ledger_amount_positive', 'amount > 0')
@Check('ck_ledger_balance_nonnegative', 'balance_before >= 0 AND balance_after >= 0')
export class LedgerEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'wallet_id', type: 'uuid' }) walletId!: string;
  @Column({ name: 'transaction_id', type: 'uuid' }) transactionId!: string;
  @Column({ type: 'varchar', length: 8 }) direction!: 'DEBIT' | 'CREDIT';
  @Column({ type: 'numeric', precision: 20, scale: 2 }) amount!: string;
  @Column({ type: 'char', length: 3 }) currency!: string;
  @Column({ name: 'balance_before', type: 'numeric', precision: 20, scale: 2 }) balanceBefore!: string;
  @Column({ name: 'balance_after', type: 'numeric', precision: 20, scale: 2 }) balanceAfter!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

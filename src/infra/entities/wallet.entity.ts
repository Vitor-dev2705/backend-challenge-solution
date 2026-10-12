import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';
@Entity('wallets')
@Index('uq_wallet_player_currency', ['playerId', 'currency'], { unique: true })
@Check('ck_wallet_balance_nonnegative', 'balance >= 0')
export class WalletEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'player_id', type: 'uuid' }) playerId!: string;
  @Column({ type: 'char', length: 3 }) currency!: string;
  @Column({ type: 'numeric', precision: 20, scale: 2, default: '0.00' }) balance!: string;
  @VersionColumn() version!: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}

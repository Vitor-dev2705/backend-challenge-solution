import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
@Entity('outbox_messages')
@Index('ix_outbox_pending', ['publishedAt', 'nextAttemptAt', 'occurredAt'])
export class OutboxEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'aggregate_id', type: 'uuid' }) aggregateId!: string;
  @Column({ name: 'event_type', type: 'varchar', length: 120 }) eventType!: string;
  @Column({ type: 'jsonb' }) payload!: Record<string, unknown>;
  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' }) occurredAt!: Date;
  @Column({ type: 'integer', default: 0 }) attempts!: number;
  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true }) nextAttemptAt!: Date | null;
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true }) publishedAt!: Date | null;
}

import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
@Entity('inbox_messages')
export class InboxEntity {
  @PrimaryColumn({ name: 'consumer_name', type: 'varchar', length: 120 }) consumerName!: string;
  @PrimaryColumn({ name: 'message_id', type: 'varchar', length: 255 }) messageId!: string;
  @Column({ name: 'payload_hash', type: 'char', length: 64 }) payloadHash!: string;
  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' }) receivedAt!: Date;
  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true }) processedAt!: Date | null;
}

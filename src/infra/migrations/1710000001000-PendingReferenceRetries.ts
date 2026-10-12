import { MigrationInterface, QueryRunner } from 'typeorm';

export class PendingReferenceRetries1710000001000 implements MigrationInterface {
  name = 'PendingReferenceRetries1710000001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE wager_transactions
      ADD COLUMN reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
      ADD COLUMN reference_next_attempt_at timestamptz`);
    await queryRunner.query(`UPDATE wager_transactions
      SET reference_next_attempt_at = now()
      WHERE status = 'PENDING_REFERENCE'`);
    await queryRunner.query(`CREATE INDEX ix_wager_reference_retry
      ON wager_transactions(reference_next_attempt_at, created_at)
      WHERE status = 'PENDING_REFERENCE'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS ix_wager_reference_retry');
    await queryRunner.query(`ALTER TABLE wager_transactions
      DROP COLUMN reference_next_attempt_at,
      DROP COLUMN reference_attempts`);
  }
}

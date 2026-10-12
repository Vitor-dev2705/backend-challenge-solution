import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProcessedReversalIndex1710000002000 implements MigrationInterface {
  name = 'ProcessedReversalIndex1710000002000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS uq_wager_reference_reversal_kind');
    await queryRunner.query(`CREATE UNIQUE INDEX uq_wager_reference_reversal_kind
      ON wager_transactions(provider_id, reference_transaction_id, kind)
      WHERE kind IN ('REFUND','ROLLBACK')
        AND reference_transaction_id IS NOT NULL
        AND status = 'PROCESSED'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS uq_wager_reference_reversal_kind');
    await queryRunner.query(`CREATE UNIQUE INDEX uq_wager_reference_reversal_kind
      ON wager_transactions(provider_id, reference_transaction_id, kind)
      WHERE kind IN ('REFUND','ROLLBACK')
        AND reference_transaction_id IS NOT NULL`);
  }
}

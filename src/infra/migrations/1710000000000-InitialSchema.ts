import { MigrationInterface, QueryRunner } from 'typeorm';
export class InitialSchema1710000000000 implements MigrationInterface {
  name = 'InitialSchema1710000000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE wallets (id uuid PRIMARY KEY, player_id uuid NOT NULL, currency char(3) NOT NULL, balance numeric(20,2) NOT NULL DEFAULT 0.00 CHECK(balance >= 0), version integer NOT NULL DEFAULT 1 CHECK(version >= 1), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT uq_wallet_player_currency UNIQUE(player_id,currency))`);
    await q.query(`CREATE TABLE wager_transactions (id uuid PRIMARY KEY, provider_id varchar(120) NOT NULL, external_transaction_id varchar(200) NOT NULL, idempotency_key varchar(255) NOT NULL, payload_hash char(64) NOT NULL, wallet_id uuid NOT NULL REFERENCES wallets(id), player_id uuid NOT NULL, round_id varchar(200) NOT NULL, game_id varchar(200) NOT NULL, kind varchar(16) NOT NULL CHECK(kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')), amount numeric(20,2) NOT NULL CHECK(amount >= 0), currency char(3) NOT NULL, reference_external_transaction_id varchar(200), reference_transaction_id uuid REFERENCES wager_transactions(id), status varchar(24) NOT NULL CHECK(status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')), failure_code varchar(80), result_balance numeric(20,2), result_version integer, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, CONSTRAINT uq_wager_idempotency_key UNIQUE(idempotency_key), CONSTRAINT uq_wager_provider_external UNIQUE(provider_id,external_transaction_id))`);
    await q.query(`CREATE INDEX ix_wager_pending_reference ON wager_transactions(status,created_at)`);
    await q.query(`CREATE UNIQUE INDEX uq_wager_reference_reversal_kind ON wager_transactions(provider_id,reference_transaction_id,kind) WHERE kind IN ('REFUND','ROLLBACK') AND reference_transaction_id IS NOT NULL`);
    await q.query(`CREATE TABLE wallet_ledger_entries (id uuid PRIMARY KEY, wallet_id uuid NOT NULL REFERENCES wallets(id), transaction_id uuid NOT NULL REFERENCES wager_transactions(id), direction varchar(8) NOT NULL CHECK(direction IN ('DEBIT','CREDIT')), amount numeric(20,2) NOT NULL CHECK(amount > 0), currency char(3) NOT NULL, balance_before numeric(20,2) NOT NULL CHECK(balance_before >= 0), balance_after numeric(20,2) NOT NULL CHECK(balance_after >= 0), created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT uq_ledger_transaction_wallet UNIQUE(transaction_id,wallet_id), CHECK((direction='DEBIT' AND balance_before-amount=balance_after) OR (direction='CREDIT' AND balance_before+amount=balance_after)))`);
    await q.query(`CREATE INDEX ix_ledger_wallet_created ON wallet_ledger_entries(wallet_id,created_at,id)`);
    await q.query(`CREATE TABLE inbox_messages (consumer_name varchar(120) NOT NULL, message_id varchar(255) NOT NULL, payload_hash char(64) NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, PRIMARY KEY(consumer_name,message_id))`);
    await q.query(`CREATE TABLE outbox_messages (id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, event_type varchar(120) NOT NULL, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0), next_attempt_at timestamptz, published_at timestamptz)`);
    await q.query(`CREATE INDEX ix_outbox_pending ON outbox_messages(published_at,next_attempt_at,occurred_at)`);
    await q.query(`CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger entries are immutable'; END; $$`);
    await q.query(`CREATE TRIGGER wallet_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation()`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TRIGGER IF EXISTS wallet_ledger_immutable ON wallet_ledger_entries');
    await q.query('DROP FUNCTION IF EXISTS prevent_ledger_mutation()');
    await q.query('DROP TABLE IF EXISTS outbox_messages'); await q.query('DROP TABLE IF EXISTS inbox_messages');
    await q.query('DROP TABLE IF EXISTS wallet_ledger_entries'); await q.query('DROP INDEX IF EXISTS uq_wager_reference_reversal_kind'); await q.query('DROP TABLE IF EXISTS wager_transactions'); await q.query('DROP TABLE IF EXISTS wallets');
  }
}

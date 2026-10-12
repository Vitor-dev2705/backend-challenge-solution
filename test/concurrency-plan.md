# Concurrency and integration test coverage

Run the implemented PostgreSQL and LocalStack integration suite with:

```powershell
$env:TEST_DATABASE_URL="postgres://wager:wager@localhost:5432/wagering_test"
$env:SQS_ENDPOINT="http://localhost:4566"
bun run test:integration
```

The suite currently verifies:

1. Fifty identical idempotent BET submissions across three PostgreSQL pools produce one debit.
2. Two concurrent BETs cannot overspend a wallet; the final balance reconciles with the ledger.
3. PostgreSQL enforces wallet uniqueness, nonnegative balances, and ledger immutability.
4. Three independent Bun processes can submit against the same wallet without overspending.
5. WIN, LOSS, REFUND, and ROLLBACK behavior, duplicate and overdraw rejections, ledger pagination, and reconciliation.
6. A durable pending refund is reprocessed after its referenced transaction arrives.
7. Inbox processing commits atomically with financial records, and concurrent outbox publishers publish claimed events.
8. Real LocalStack SQS consumption, duplicate delivery handling, and routing malformed messages to the DLQ.

The following failure scenarios remain useful follow-up coverage and are not simulated by the current suite:

- Independently contending wallets to demonstrate there is no global wallet lock.
- Killing a consumer after the database commit but before SQS acknowledgement, then verifying redelivery.
- Restarting the service with in-flight messages and reconciling after restart.
- Exhausting transient SQS retries and verifying the configured receive-count/DLQ policy.

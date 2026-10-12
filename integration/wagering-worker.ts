import { DataSource } from 'typeorm';
import { WageringService } from '../src/application/wagering.service';
import { InboxEntity } from '../src/infra/entities/inbox.entity';
import { LedgerEntity } from '../src/infra/entities/ledger.entity';
import { OutboxEntity } from '../src/infra/entities/outbox.entity';
import { WagerTransactionEntity } from '../src/infra/entities/wager-transaction.entity';
import { WalletEntity } from '../src/infra/entities/wallet.entity';
import type { CreateWagerDto } from '../src/http/dto/create-wager.dto';

interface WorkerRequest { dto: CreateWagerDto; idempotencyKey: string }

async function main(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');
  const dataSource = new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [WalletEntity, WagerTransactionEntity, LedgerEntity, InboxEntity, OutboxEntity],
    synchronize: false,
    logging: false
  });
  await dataSource.initialize();
  try {
    const request = JSON.parse(await Bun.stdin.text()) as WorkerRequest;
    const response = await new WageringService(dataSource).submit(request.dto, request.idempotencyKey);
    console.log(`WORKER_RESULT:${JSON.stringify(response)}`);
  } finally {
    await dataSource.destroy();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'UNKNOWN_WORKER_ERROR');
  process.exitCode = 1;
});

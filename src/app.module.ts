import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './http/app.controller';
import { WageringService } from './application/wagering.service';
import { SqsService } from './infra/sqs.service';
import { WalletEntity } from './infra/entities/wallet.entity';
import { WagerTransactionEntity } from './infra/entities/wager-transaction.entity';
import { LedgerEntity } from './infra/entities/ledger.entity';
import { InboxEntity } from './infra/entities/inbox.entity';
import { OutboxEntity } from './infra/entities/outbox.entity';
@Module({ imports: [TypeOrmModule.forFeature([WalletEntity, WagerTransactionEntity, LedgerEntity, InboxEntity, OutboxEntity]), TypeOrmModule.forRoot({ type: 'postgres', url: process.env.DATABASE_URL ?? 'postgres://wager:wager@localhost:5432/wagering', entities: [WalletEntity, WagerTransactionEntity, LedgerEntity, InboxEntity, OutboxEntity], synchronize: false, autoLoadEntities: true })], controllers: [AppController], providers: [WageringService, SqsService] })
export class AppModule {}

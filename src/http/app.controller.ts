import { Body, Controller, Get, Header, Headers, HttpException, HttpStatus, Param, ParseIntPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { WageringService } from '../application/wagering.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { CreateWagerDto } from './dto/create-wager.dto';
import { SqsService } from '../infra/sqs.service';
import { metrics } from '../infra/metrics.service';
import { ProviderIdentityGuard } from './provider-identity.guard';

function mapError(error: unknown): never {
  const code = error instanceof Error ? error.message : 'INTERNAL_ERROR';
  const driverError = typeof error === 'object' && error !== null && 'driverError' in error ? error.driverError : undefined;
  const databaseCode = typeof driverError === 'object' && driverError !== null && 'code' in driverError ? driverError.code : undefined;
  const transient = typeof databaseCode === 'string' && (databaseCode.startsWith('08') || ['40001', '40P01', '55P03', '53300', '57P01', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(databaseCode));
  const mapping: Record<string, number> = {
    INVALID_MONEY_AMOUNT: 400, INVALID_CURRENCY: 400, INVALID_TRANSACTION_AMOUNT: 400, INVALID_INITIAL_BALANCE: 400,
    IDEMPOTENCY_KEY_REQUIRED: 400, IDEMPOTENCY_KEY_INVALID: 400, REFERENCE_REQUIRED: 400, INVALID_CURSOR: 400, INVALID_LIMIT: 400,
    IDEMPOTENCY_CONFLICT: 409, INBOX_PAYLOAD_CONFLICT: 409, WALLET_ALREADY_EXISTS: 409, INSUFFICIENT_FUNDS: 422, REVERSAL_WOULD_OVERDRAW: 422,
    WALLET_NOT_FOUND: 404, TRANSACTION_NOT_FOUND: 404, CURRENCY_MISMATCH: 422,
    REFERENCE_NOT_PROCESSED: 422, REFERENCE_NOT_FOUND: 422, REFERENCE_SCOPE_MISMATCH: 422, INVALID_WIN_REFERENCE: 422, INVALID_REFUND_REFERENCE: 422,
    INVALID_ROLLBACK_REFERENCE: 422, REFERENCE_AMOUNT_MISMATCH: 422, REFERENCE_ALREADY_REVERSED: 422
  };
  const statusCode = mapping[code] ?? (transient ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.INTERNAL_SERVER_ERROR);
  throw new HttpException({ statusCode, error: code, retryable: transient }, statusCode);
}
@Controller()
@UseGuards(ProviderIdentityGuard)
export class AppController {
  constructor(private readonly wagering: WageringService, private readonly dataSource: DataSource, private readonly sqs: SqsService) {}
  @Post('wallets') async createWallet(@Body() body: CreateWalletDto) { try { return await this.wagering.createWallet(body.playerId, body.initialBalance); } catch (e) { return mapError(e); } }
  @Get('wallets/:walletId') async getWallet(@Param('walletId') id: string) { try { return await this.wagering.getWallet(id); } catch (e) { return mapError(e); } }
  @Get('wallets/:walletId/ledger') async ledger(@Param('walletId') id: string, @Query('cursor') cursor?: string, @Query('limit', new ParseIntPipe({ optional: true })) limit?: number) { try { return await this.wagering.ledger(id, limit ?? 50, cursor); } catch (e) { return mapError(e); } }
  @Post('wallets/:walletId/reconciliation') async reconcile(@Param('walletId') id: string) { try { return await this.wagering.reconcile(id); } catch (e) { return mapError(e); } }
  @Post('wagering/transactions') async submit(@Body() body: CreateWagerDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) response: Response) { try { const result = await this.wagering.submit(body, key ?? ''); if (result.status === 'REJECTED') response.status(422); else if (result.status === 'PENDING_REFERENCE') response.status(202); return result; } catch (e) { return mapError(e); } }
  @Get('wagering/transactions/:transactionId') async getTransaction(@Param('transactionId') id: string) { try { return await this.wagering.getTransaction(id); } catch (e) { return mapError(e); } }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId') async getExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) { try { return await this.wagering.getExternalTransaction(providerId, externalId); } catch (e) { return mapError(e); } }
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('metrics') @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8') metricsEndpoint() { return metrics.render(); }
  @Get('health/ready') async ready() { const db = await this.dataSource.query('SELECT 1').then(() => true).catch(() => false); const sqs = await this.sqs.checkReady(); const status = db && sqs; if (!status) throw new HttpException({ status: 'unavailable', postgres: db, sqs }, 503); return { status: 'ok', postgres: db, sqs }; }
}

import { IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
class MoneyDto { @IsString() @Matches(/^(0|[1-9]\d*)(\.\d{1,2})?$/) amount!: string; @IsString() @Length(3,3) currency!: string; }
export class CreateWagerDto {
  @IsString() @Length(1,120) providerId!: string;
  @IsString() @Length(1,200) externalTransactionId!: string;
  @IsUUID() playerId!: string;
  @IsUUID() walletId!: string;
  @IsString() @Length(1,200) roundId!: string;
  @IsString() @Length(1,200) gameId!: string;
  @IsIn(['BET','WIN','LOSS','REFUND','ROLLBACK']) kind!: 'BET'|'WIN'|'LOSS'|'REFUND'|'ROLLBACK';
  @ValidateNested() @Type(() => MoneyDto) money!: MoneyDto;
  @IsOptional() @IsString() @Length(1,200) referenceExternalTransactionId?: string;
}

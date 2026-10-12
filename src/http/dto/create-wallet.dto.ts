import { IsString, IsUUID, Length, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
class MoneyDto { @IsString() @Matches(/^(0|[1-9]\d*)(\.\d{1,2})?$/) amount!: string; @IsString() @Length(3,3) currency!: string; }
export class CreateWalletDto { @IsUUID() playerId!: string; @ValidateNested() @Type(() => MoneyDto) initialBalance!: MoneyDto; }

import { Money } from './money';

export interface WalletState { id: string; playerId: string; currency: string; balance: Money; version: number; createdAt: Date; updatedAt: Date }
export class Wallet {
  private constructor(public readonly id: string, public readonly playerId: string, public readonly currency: string,
    private _balance: Money, private _version: number, public readonly createdAt: Date, private _updatedAt: Date) {}
  static open(props: { id: string; playerId: string; initialBalance: Money; now?: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new Error('INVALID_INITIAL_BALANCE');
    const now = props.now ?? new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, now, now);
  }
  static rehydrate(state: WalletState): Wallet { return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt); }
  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }
  debit(amount: Money, now = new Date()): { before: Money; after: Money; version: number } {
    this.assertCurrency(amount); if (amount.isNegative() || amount.isZero()) throw new Error('INVALID_TRANSACTION_AMOUNT');
    const before = this._balance; const after = before.subtract(amount);
    if (after.isNegative()) throw new Error('INSUFFICIENT_FUNDS');
    this.apply(after, now); return { before, after, version: this._version };
  }
  credit(amount: Money, now = new Date()): { before: Money; after: Money; version: number } {
    this.assertCurrency(amount); if (amount.isNegative() || amount.isZero()) throw new Error('INVALID_TRANSACTION_AMOUNT');
    const before = this._balance; const after = before.add(amount); this.apply(after, now);
    return { before, after, version: this._version };
  }
  private apply(balance: Money, now: Date): void { this._balance = balance; this._version += 1; this._updatedAt = now; }
  private assertCurrency(money: Money): void { if (money.currency !== this.currency) throw new Error('CURRENCY_MISMATCH'); }
}

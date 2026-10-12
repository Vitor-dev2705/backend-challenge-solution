import Decimal from 'decimal.js';

export interface MoneyProps { amount: string; currency: string }
const AMOUNT = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_INTEGER_DIGITS = 18;
const MAX_AMOUNT = new Decimal('999999999999999999.99');

/** Immutable money value object. Monetary values are never represented by JS number. */
export class Money {
  private constructor(private readonly value: Decimal, public readonly currency: string) {
    const normalized = value.toDecimalPlaces(2);
    if (normalized.abs().greaterThan(MAX_AMOUNT)) throw new Error('INVALID_MONEY_AMOUNT');
    this.value = normalized.isZero() ? new Decimal('0.00') : normalized;
  }

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !AMOUNT.test(props.amount) || props.amount.split('.')[0]!.length > MAX_INTEGER_DIGITS) {
      throw new Error('INVALID_MONEY_AMOUNT');
    }
    if (!CURRENCY.test(props.currency)) throw new Error('INVALID_CURRENCY');
    const decimal = new Decimal(props.amount);
    if (!decimal.isFinite() || decimal.isNegative()) throw new Error('INVALID_MONEY_AMOUNT');
    return new Money(decimal.toDecimalPlaces(2), props.currency);
  }

  static zero(currency: string): Money { return Money.from({ amount: '0.00', currency }); }
  static fromSigned(amount: string, currency: string): Money {
    if (!/^-?(0|[1-9]\d*)(\.\d{1,2})?$/.test(amount) || amount.replace(/^-/, '').split('.')[0]!.length > MAX_INTEGER_DIGITS) throw new Error('INVALID_MONEY_AMOUNT');
    if (!CURRENCY.test(currency)) throw new Error('INVALID_CURRENCY');
    const decimal = new Decimal(amount);
    if (!decimal.isFinite() || (decimal.isZero() && amount.startsWith('-'))) throw new Error('INVALID_MONEY_AMOUNT');
    return new Money(decimal.toDecimalPlaces(2), currency);
  }
  add(other: Money): Money { this.assertSameCurrency(other); return new Money(this.value.plus(other.value), this.currency); }
  subtract(other: Money): Money { this.assertSameCurrency(other); return new Money(this.value.minus(other.value), this.currency); }
  negate(): Money { return new Money(this.value.negated(), this.currency); }
  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.isPositive(); }
  isNegative(): boolean { return this.value.isNegative() && !this.value.isZero(); }
  isLessThan(other: Money): boolean { this.assertSameCurrency(other); return this.value.lessThan(other.value); }
  equals(other: Money): boolean { return this.currency === other.currency && this.value.equals(other.value); }
  toJSON(): MoneyProps { return { amount: this.value.toFixed(2), currency: this.currency }; }
  toString(): string { return `${this.value.toFixed(2)} ${this.currency}`; }
  private assertSameCurrency(other: Money): void { if (this.currency !== other.currency) throw new Error('CURRENCY_MISMATCH'); }
}

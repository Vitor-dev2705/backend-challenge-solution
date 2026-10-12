import { describe, expect, test } from 'bun:test';
import { Money } from '../src/domain/money';

describe('Money', () => {
  test('uses exact decimal arithmetic and fixed scale', () => {
    expect(Money.from({ amount: '0.10', currency: 'BRL' }).add(Money.from({ amount: '0.20', currency: 'BRL' })).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
  });
  test('rejects scientific notation, negative input and excess scale', () => {
    expect(() => Money.from({ amount: '1e3', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '-1.00', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '1.001', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: 'NaN', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: 'Infinity', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '1000000000000000000.00', currency: 'BRL' })).toThrow();
  });
  test('rejects signed zero and mixed currencies', () => {
    expect(() => Money.fromSigned('-0.00', 'BRL')).toThrow();
    expect(() => Money.from({ amount: '1.00', currency: 'BRL' }).add(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow('CURRENCY_MISMATCH');
  });
});

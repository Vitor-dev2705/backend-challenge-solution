import { describe, expect, test } from 'bun:test';
import { Money } from '../src/domain/money';
import { Wallet } from '../src/domain/wallet';

describe('Wallet', () => {
  test('debits without allowing a negative balance', () => {
    const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }) });
    wallet.debit(Money.from({ amount: '80.00', currency: 'BRL' }));
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(() => wallet.debit(Money.from({ amount: '21.00', currency: 'BRL' }))).toThrow('INSUFFICIENT_FUNDS');
  });
  test('increments version only on a balance change', () => {
    const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: Money.zero('BRL') });
    wallet.credit(Money.from({ amount: '2.00', currency: 'BRL' }));
    expect(wallet.version).toBe(2);
  });
});

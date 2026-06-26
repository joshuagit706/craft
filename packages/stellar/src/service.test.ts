import { describe, it, expect, vi, afterEach } from 'vitest';
import { Networks } from 'stellar-sdk';
import { server, loadAccount, getAccountBalance, submitTransaction } from './service';

describe('Stellar wrapper service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads account using the shared server wrapper', async () => {
    const account = {
      id: 'GABC',
      balances: [{ asset_type: 'native', balance: '10.0000000' }],
    } as any;

    vi.spyOn(server, 'loadAccount').mockResolvedValue(account);

    await expect(loadAccount('GABC')).resolves.toEqual(account);
  });

  it('returns balances from loaded account', async () => {
    const balances = [{ asset_type: 'native', balance: '42.0000000' }] as any;
    vi.spyOn(server, 'loadAccount').mockResolvedValue({ balances } as any);

    await expect(getAccountBalance('GABC')).resolves.toEqual(balances);
  });

  it('wraps account load failures with descriptive wrapper error', async () => {
    vi.spyOn(server, 'loadAccount').mockRejectedValue(new Error('Account not found (404)'));

    await expect(loadAccount('GBAD')).rejects.toThrow('Failed to load account');
  });

  it('submits transactions through the shared server wrapper', async () => {
    const response = { id: 'tx_123', successful: true } as any;
    vi.spyOn(server, 'submitTransaction').mockResolvedValue(response);

    const tx = { hash: () => 'abc123', networkPassphrase: Networks.TESTNET } as any;
    await expect(submitTransaction(tx)).resolves.toEqual(response);
  });

  it('wraps submit transaction failures with descriptive wrapper error', async () => {
    vi.spyOn(server, 'submitTransaction').mockRejectedValue(new Error('txFAILED'));

    const tx = { hash: () => 'deadbeef', networkPassphrase: Networks.TESTNET } as any;
    await expect(submitTransaction(tx)).rejects.toThrow('Failed to submit transaction');
  });
});

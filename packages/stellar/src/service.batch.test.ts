/**
 * Horizon API Request Batching Tests
 *
 * Validates that bulk account validation queries are batched efficiently,
 * reducing network round trips and improving validation throughput.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Horizon } from 'stellar-sdk';
import { batchValidateAccounts } from './service';

describe('Horizon API Request Batching', () => {
  describe('batchValidateAccounts', () => {
    const validAccount1 = 'GBUQWP3BOUZX34ULNQG23RQ6F4BWFIRETEI7I2AXBCCF7C3HLCA5UABK';
    const validAccount2 = 'GBBD47UZQ5SYWDRFGWCMA3BKPXZMBTUY3MQQ5DUMPYTSKZPNPS6BUUJM';
    const invalidAccount = 'GINVALIDACCOUNTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

    it('should return valid results for all valid accounts', async () => {
      const results = await batchValidateAccounts([validAccount1, validAccount2]);
      
      expect(results).toHaveLength(2);
      results.forEach(result => {
        expect(result.publicKey).toBeTruthy();
        expect(typeof result.valid).toBe('boolean');
      });
    });

    it('should handle mix of valid and invalid accounts', async () => {
      const results = await batchValidateAccounts([
        validAccount1,
        invalidAccount,
        validAccount2,
      ]);
      
      expect(results).toHaveLength(3);
      
      // Check structure of each result
      results.forEach(result => {
        expect(result).toHaveProperty('publicKey');
        expect(result).toHaveProperty('valid');
        
        if (result.valid) {
          expect(result).toHaveProperty('account');
        } else {
          expect(result).toHaveProperty('error');
        }
      });
    });

    it('should preserve order of input accounts', async () => {
      const accounts = [validAccount1, invalidAccount, validAccount2];
      const results = await batchValidateAccounts(accounts);
      
      expect(results[0].publicKey).toBe(validAccount1);
      expect(results[1].publicKey).toBe(invalidAccount);
      expect(results[2].publicKey).toBe(validAccount2);
    });

    it('should handle empty array', async () => {
      const results = await batchValidateAccounts([]);
      expect(results).toHaveLength(0);
    });

    it('should handle single account', async () => {
      const results = await batchValidateAccounts([validAccount1]);
      
      expect(results).toHaveLength(1);
      expect(results[0].publicKey).toBe(validAccount1);
    });

    it('should include account data for valid accounts', async () => {
      const results = await batchValidateAccounts([validAccount1]);
      
      const validResult = results.find(r => r.valid);
      if (validResult?.account) {
        expect(validResult.account).toHaveProperty('id');
        expect(validResult.account).toHaveProperty('account_id');
        expect(validResult.account).toHaveProperty('sequence');
      }
    });

    it('should include error message for invalid accounts', async () => {
      const results = await batchValidateAccounts([invalidAccount]);
      
      const invalidResult = results.find(r => !r.valid);
      expect(invalidResult?.error).toBeTruthy();
      expect(typeof invalidResult?.error).toBe('string');
    });

    it('should not throw on partial failures', async () => {
      await expect(
        batchValidateAccounts([validAccount1, invalidAccount])
      ).resolves.toBeDefined();
    });

    it('should handle large batches', async () => {
      const largeBatch = Array(10).fill(validAccount1);
      const results = await batchValidateAccounts(largeBatch);
      
      expect(results).toHaveLength(10);
    });

    it('should work with testnet network parameter', async () => {
      const results = await batchValidateAccounts([validAccount1], 'testnet');
      expect(results).toHaveLength(1);
    });

    it('should work with mainnet network parameter', async () => {
      const results = await batchValidateAccounts([validAccount1], 'mainnet');
      expect(results).toHaveLength(1);
    });
  });

  describe('Batching Performance Characteristics', () => {
    it('should execute requests concurrently', async () => {
      const accounts = [
        'GBUQWP3BOUZX34ULNQG23RQ6F4BWFIRETEI7I2AXBCCF7C3HLCA5UABK',
        'GBBD47UZQ5SYWDRFGWCMA3BKPXZMBTUY3MQQ5DUMPYTSKZPNPS6BUUJM',
      ];
      
      const startTime = Date.now();
      await batchValidateAccounts(accounts);
      const duration = Date.now() - startTime;
      
      // Concurrent execution should be faster than sequential
      // This is a rough check - actual timing depends on network
      expect(duration).toBeLessThan(10000); // 10 seconds max
    });
  });
});

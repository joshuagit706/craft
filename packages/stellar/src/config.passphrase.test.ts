/**
 * Network Passphrase Validation Tests
 *
 * Validates that network passphrase validation prevents cross-network
 * transaction replay attacks.
 */

import { describe, it, expect } from 'vitest';
import { Networks } from 'stellar-sdk';
import { validateNetworkPassphrase, NETWORK_PASSPHRASES } from './config';

describe('Network Passphrase Validation', () => {
  describe('validateNetworkPassphrase', () => {
    it('should accept correct testnet passphrase', () => {
      expect(() => {
        validateNetworkPassphrase(Networks.TESTNET, 'testnet');
      }).not.toThrow();
    });

    it('should accept correct mainnet passphrase', () => {
      expect(() => {
        validateNetworkPassphrase(Networks.PUBLIC, 'mainnet');
      }).not.toThrow();
    });

    it('should reject mainnet passphrase for testnet', () => {
      expect(() => {
        validateNetworkPassphrase(Networks.PUBLIC, 'testnet');
      }).toThrow(/Network passphrase mismatch/);
    });

    it('should reject testnet passphrase for mainnet', () => {
      expect(() => {
        validateNetworkPassphrase(Networks.TESTNET, 'mainnet');
      }).toThrow(/Network passphrase mismatch/);
    });

    it('should reject arbitrary passphrase', () => {
      expect(() => {
        validateNetworkPassphrase('Invalid Network Passphrase', 'mainnet');
      }).toThrow(/Network passphrase mismatch/);
    });

    it('should include expected and actual passphrases in error', () => {
      try {
        validateNetworkPassphrase(Networks.TESTNET, 'mainnet');
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain(Networks.TESTNET);
        expect(error.message).toContain(Networks.PUBLIC);
        expect(error.message).toContain('mainnet');
      }
    });

    it('should mention cross-network replay prevention in error', () => {
      try {
        validateNetworkPassphrase(Networks.PUBLIC, 'testnet');
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('cross-network transaction replay');
      }
    });

    it('should use environment network when target not specified', () => {
      // This test validates the default behavior
      const envPassphrase = NETWORK_PASSPHRASES[
        process.env.STELLAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
      ];
      
      expect(() => {
        validateNetworkPassphrase(envPassphrase);
      }).not.toThrow();
    });
  });

  describe('Passphrase Constants', () => {
    it('should have correct testnet passphrase', () => {
      expect(NETWORK_PASSPHRASES.testnet).toBe(Networks.TESTNET);
      expect(NETWORK_PASSPHRASES.testnet).toBe('Test SDF Network ; September 2015');
    });

    it('should have correct mainnet passphrase', () => {
      expect(NETWORK_PASSPHRASES.mainnet).toBe(Networks.PUBLIC);
      expect(NETWORK_PASSPHRASES.mainnet).toBe('Public Global Stellar Network ; September 2015');
    });

    it('should have different passphrases for different networks', () => {
      expect(NETWORK_PASSPHRASES.testnet).not.toBe(NETWORK_PASSPHRASES.mainnet);
    });
  });
});

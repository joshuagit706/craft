/**
 * Cross-Network Deterministic Tests for Stellar Configuration
 *
 * Validates all configuration differences between Stellar testnet and mainnet
 * deployments, ensuring the platform correctly handles network-specific parameters.
 *
 * Test Coverage:
 *   - Network passphrase validation
 *   - Horizon URL configuration
 *   - Soroban RPC endpoint configuration
 *   - Asset code and issuer validation
 *   - Configuration divergence detection
 *   - Passphrase mismatch detection
 */

import { describe, it, expect } from 'vitest';
import { Networks } from 'stellar-sdk';
import {
  TESTNET_CONFIG,
  MAINNET_CONFIG,
  NETWORK_CONFIGS,
  STANDARD_ASSET_CODES,
  TESTNET_ASSET_ISSUERS,
  MAINNET_ASSET_ISSUERS,
  NETWORK_PARAMETERS,
  PASSPHRASE_VALIDATION,
  HORIZON_ENDPOINT_VALIDATION,
  SOROBAN_RPC_ENDPOINT_VALIDATION,
  TEST_ACCOUNTS,
  validateNetworkDivergence,
  validatePassphraseMismatch,
  validateConfigurationConsistency,
} from './__fixtures__/stellar-networks';
import type { StellarNetworkConfig } from '@craft/types';

describe('Stellar Cross-Network Configuration Tests', () => {
  describe('Parameterized Network Configuration Tests', () => {
    const networks = ['testnet', 'mainnet'] as const;

    networks.forEach(network => {
      describe(`${network} Configuration`, () => {
        const config = NETWORK_CONFIGS[network];

        it(`should have valid network name for ${network}`, () => {
          expect(config.network).toBe(network);
        });

        it(`should have valid passphrase for ${network}`, () => {
          const expectedPassphrase =
            network === 'testnet' ? Networks.TESTNET : Networks.PUBLIC;
          expect(config.networkPassphrase).toBe(expectedPassphrase);
        });

        it(`should have valid Horizon URL for ${network}`, () => {
          expect(config.horizonUrl).toMatch(/^https:\/\//);
          if (network === 'testnet') {
            expect(config.horizonUrl).toContain('testnet');
          } else {
            expect(config.horizonUrl).not.toContain('testnet');
          }
        });

        it(`should have valid Soroban RPC URL for ${network}`, () => {
          expect(config.sorobanRpcUrl).toMatch(/^https:\/\//);
          if (network === 'testnet') {
            expect(config.sorobanRpcUrl).toContain('testnet');
          }
        });

        it(`should pass consistency check for ${network}`, () => {
          const result = validateConfigurationConsistency(config);
          expect(result.isValid).toBe(true);
          expect(result.errors).toHaveLength(0);
        });
      });
    });
  });

  describe('Network Divergence Validation', () => {
    it('should have different passphrases between testnet and mainnet', () => {
      expect(TESTNET_CONFIG.networkPassphrase).not.toBe(
        MAINNET_CONFIG.networkPassphrase
      );
    });

    it('should have different Horizon URLs between testnet and mainnet', () => {
      expect(TESTNET_CONFIG.horizonUrl).not.toBe(MAINNET_CONFIG.horizonUrl);
    });

    it('should have different Soroban RPC URLs between testnet and mainnet', () => {
      expect(TESTNET_CONFIG.sorobanRpcUrl).not.toBe(
        MAINNET_CONFIG.sorobanRpcUrl
      );
    });

    it('should have different network names between testnet and mainnet', () => {
      expect(TESTNET_CONFIG.network).not.toBe(MAINNET_CONFIG.network);
    });

    it('should pass divergence validation', () => {
      const result = validateNetworkDivergence();
      expect(result.isValid).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });
  });

  describe('Passphrase Mismatch Detection', () => {
    it('should detect passphrase mismatch for testnet', () => {
      const result = validatePassphraseMismatch('testnet', Networks.PUBLIC);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Passphrase mismatch');
    });

    it('should detect passphrase mismatch for mainnet', () => {
      const result = validatePassphraseMismatch('mainnet', Networks.TESTNET);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Passphrase mismatch');
    });

    it('should accept correct passphrase for testnet', () => {
      const result = validatePassphraseMismatch('testnet', Networks.TESTNET);
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept correct passphrase for mainnet', () => {
      const result = validatePassphraseMismatch('mainnet', Networks.PUBLIC);
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Asset Code Validation', () => {
    it('should have standard asset codes defined', () => {
      expect(STANDARD_ASSET_CODES.native).toBe('XLM');
      expect(STANDARD_ASSET_CODES.usdc).toBe('USDC');
      expect(STANDARD_ASSET_CODES.eurc).toBe('EURC');
      expect(STANDARD_ASSET_CODES.test).toBe('TEST');
    });

    it('should have testnet asset issuers defined', () => {
      expect(TESTNET_ASSET_ISSUERS.usdc).toBeTruthy();
      expect(TESTNET_ASSET_ISSUERS.eurc).toBeTruthy();
      expect(TESTNET_ASSET_ISSUERS.test).toBeTruthy();
    });

    it('should have mainnet asset issuers defined', () => {
      expect(MAINNET_ASSET_ISSUERS.usdc).toBeTruthy();
      expect(MAINNET_ASSET_ISSUERS.eurc).toBeTruthy();
    });

    it('should have different issuers for testnet and mainnet', () => {
      // USDC issuer should differ between networks
      expect(TESTNET_ASSET_ISSUERS.usdc).not.toBe(
        MAINNET_ASSET_ISSUERS.usdc
      );
    });

    it('should have valid Stellar account addresses for issuers', () => {
      const issuers = [
        ...Object.values(TESTNET_ASSET_ISSUERS),
        ...Object.values(MAINNET_ASSET_ISSUERS),
      ];

      issuers.forEach(issuer => {
        // Stellar addresses start with G and are 56 characters
        expect(issuer).toMatch(/^G[A-Z2-7]{55}$/);
      });
    });
  });

  describe('Network Parameters Validation', () => {
    it('should have consistent base reserve across networks', () => {
      expect(NETWORK_PARAMETERS.testnet.baseReserve).toBe(
        NETWORK_PARAMETERS.mainnet.baseReserve
      );
    });

    it('should have consistent base fee across networks', () => {
      expect(NETWORK_PARAMETERS.testnet.baseFee).toBe(
        NETWORK_PARAMETERS.mainnet.baseFee
      );
    });

    it('should have consistent max transaction size across networks', () => {
      expect(NETWORK_PARAMETERS.testnet.maxTxSize).toBe(
        NETWORK_PARAMETERS.mainnet.maxTxSize
      );
    });

    it('should have consistent ledger close time across networks', () => {
      expect(NETWORK_PARAMETERS.testnet.ledgerCloseTime).toBe(
        NETWORK_PARAMETERS.mainnet.ledgerCloseTime
      );
    });
  });

  describe('Passphrase Validation Fixtures', () => {
    it('should have correct testnet passphrase', () => {
      expect(PASSPHRASE_VALIDATION.testnet.actual).toBe(
        PASSPHRASE_VALIDATION.testnet.expected
      );
    });

    it('should have correct mainnet passphrase', () => {
      expect(PASSPHRASE_VALIDATION.mainnet.actual).toBe(
        PASSPHRASE_VALIDATION.mainnet.expected
      );
    });

    it('should have different passphrases in validation fixtures', () => {
      expect(PASSPHRASE_VALIDATION.testnet.actual).not.toBe(
        PASSPHRASE_VALIDATION.mainnet.actual
      );
    });
  });

  describe('Horizon Endpoint Validation', () => {
    it('should have valid testnet Horizon URL', () => {
      expect(HORIZON_ENDPOINT_VALIDATION.testnet.url).toMatch(/^https:\/\//);
      expect(HORIZON_ENDPOINT_VALIDATION.testnet.url).toContain('testnet');
    });

    it('should have valid mainnet Horizon URL', () => {
      expect(HORIZON_ENDPOINT_VALIDATION.mainnet.url).toMatch(/^https:\/\//);
      expect(HORIZON_ENDPOINT_VALIDATION.mainnet.url).not.toContain('testnet');
    });

    it('should have health check endpoint defined', () => {
      expect(HORIZON_ENDPOINT_VALIDATION.testnet.healthCheck).toBe('/health');
      expect(HORIZON_ENDPOINT_VALIDATION.mainnet.healthCheck).toBe('/health');
    });
  });

  describe('Soroban RPC Endpoint Validation', () => {
    it('should have valid testnet Soroban RPC URL', () => {
      expect(SOROBAN_RPC_ENDPOINT_VALIDATION.testnet.url).toMatch(/^https:\/\//);
      expect(SOROBAN_RPC_ENDPOINT_VALIDATION.testnet.url).toContain('testnet');
    });

    it('should have valid mainnet Soroban RPC URL', () => {
      expect(SOROBAN_RPC_ENDPOINT_VALIDATION.mainnet.url).toMatch(/^https:\/\//);
    });

    it('should have RPC method defined', () => {
      expect(SOROBAN_RPC_ENDPOINT_VALIDATION.testnet.method).toBe('getNetwork');
      expect(SOROBAN_RPC_ENDPOINT_VALIDATION.mainnet.method).toBe('getNetwork');
    });
  });

  describe('Test Account Fixtures', () => {
    it('should have valid testnet test account', () => {
      expect(TEST_ACCOUNTS.testnet.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    });

    it('should have valid mainnet test account', () => {
      expect(TEST_ACCOUNTS.mainnet.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    });

    it('should have placeholder private keys (never real keys)', () => {
      expect(TEST_ACCOUNTS.testnet.privateKeyPlaceholder).toMatch(/^SB/);
      expect(TEST_ACCOUNTS.mainnet.privateKeyPlaceholder).toMatch(/^SB/);
      expect(TEST_ACCOUNTS.testnet.privateKeyPlaceholder).toContain('X');
      expect(TEST_ACCOUNTS.mainnet.privateKeyPlaceholder).toContain('X');
    });

    it('should not contain real private keys', () => {
      const testnetKey = TEST_ACCOUNTS.testnet.privateKeyPlaceholder;
      const mainnetKey = TEST_ACCOUNTS.mainnet.privateKeyPlaceholder;

      // Should be placeholders, not real keys
      expect(testnetKey).toContain('X');
      expect(mainnetKey).toContain('X');
    });
  });

  describe('Configuration Consistency', () => {
    it('should detect invalid Horizon URL (non-HTTPS)', () => {
      const invalidConfig: StellarNetworkConfig = {
        network: 'testnet',
        horizonUrl: 'http://horizon-testnet.stellar.org', // HTTP instead of HTTPS
        networkPassphrase: Networks.TESTNET,
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
      };

      const result = validateConfigurationConsistency(invalidConfig);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should detect invalid Soroban RPC URL (non-HTTPS)', () => {
      const invalidConfig: StellarNetworkConfig = {
        network: 'mainnet',
        horizonUrl: 'https://horizon.stellar.org',
        networkPassphrase: Networks.PUBLIC,
        sorobanRpcUrl: 'http://mainnet.stellar.org', // HTTP instead of HTTPS
      };

      const result = validateConfigurationConsistency(invalidConfig);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should detect testnet config with mainnet passphrase', () => {
      const invalidConfig: StellarNetworkConfig = {
        network: 'testnet',
        horizonUrl: 'https://horizon-testnet.stellar.org',
        networkPassphrase: Networks.PUBLIC, // Wrong passphrase
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
      };

      const result = validateConfigurationConsistency(invalidConfig);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should detect mainnet config with testnet Horizon URL', () => {
      const invalidConfig: StellarNetworkConfig = {
        network: 'mainnet',
        horizonUrl: 'https://horizon-testnet.stellar.org', // Testnet URL
        networkPassphrase: Networks.PUBLIC,
        sorobanRpcUrl: 'https://mainnet.stellar.org',
      };

      const result = validateConfigurationConsistency(invalidConfig);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Network Configuration Reference Table', () => {
    it('should provide complete network configuration reference', () => {
      const reference = {
        testnet: TESTNET_CONFIG,
        mainnet: MAINNET_CONFIG,
      };

      expect(reference.testnet).toHaveProperty('network');
      expect(reference.testnet).toHaveProperty('horizonUrl');
      expect(reference.testnet).toHaveProperty('networkPassphrase');
      expect(reference.testnet).toHaveProperty('sorobanRpcUrl');

      expect(reference.mainnet).toHaveProperty('network');
      expect(reference.mainnet).toHaveProperty('horizonUrl');
      expect(reference.mainnet).toHaveProperty('networkPassphrase');
      expect(reference.mainnet).toHaveProperty('sorobanRpcUrl');
    });
  });
});

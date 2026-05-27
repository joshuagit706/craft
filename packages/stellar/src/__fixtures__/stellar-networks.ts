/**
 * Stellar Network Configuration Fixtures
 *
 * Deterministic test fixtures capturing all configuration differences
 * between Stellar testnet and mainnet deployments.
 *
 * These fixtures ensure the platform correctly handles network-specific
 * parameters and detects configuration divergence.
 */

import { Networks } from 'stellar-sdk';
import type { StellarNetworkConfig } from '@craft/types';

/**
 * Testnet Configuration Fixture
 *
 * Network: Stellar Testnet
 * Purpose: Development and testing
 * Reset: Periodically (check Stellar docs for schedule)
 */
export const TESTNET_CONFIG: StellarNetworkConfig = {
  network: 'testnet',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
  sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
};

/**
 * Mainnet Configuration Fixture
 *
 * Network: Stellar Mainnet (Public)
 * Purpose: Production deployments
 * Reset: Never (persistent ledger)
 */
export const MAINNET_CONFIG: StellarNetworkConfig = {
  network: 'mainnet',
  horizonUrl: 'https://horizon.stellar.org',
  networkPassphrase: Networks.PUBLIC,
  sorobanRpcUrl: 'https://mainnet.stellar.validationcloud.io/v1/soroban/rpc',
};

/**
 * Network Configuration Comparison
 *
 * Validates that testnet and mainnet configs share no conflicting values
 */
export const NETWORK_CONFIGS = {
  testnet: TESTNET_CONFIG,
  mainnet: MAINNET_CONFIG,
} as const;

/**
 * Asset Codes for Testing
 *
 * Standard Stellar asset codes used across networks
 */
export const STANDARD_ASSET_CODES = {
  native: 'XLM',
  usdc: 'USDC',
  eurc: 'EURC',
  test: 'TEST',
} as const;

/**
 * Testnet Asset Issuers
 *
 * Well-known asset issuers on testnet for testing
 */
export const TESTNET_ASSET_ISSUERS = {
  usdc: 'GBBD47UZQ5SYWDRFGWCMA3BKPXZMBTUY3MQQ5DUMPYTSKZPNPS6BUUJM',
  eurc: 'GBBD47UZQ5SYWDRFGWCMA3BKPXZMBTUY3MQQ5DUMPYTSKZPNPS6BUUJM',
  test: 'GBUQWP3BOUZX34ULNQG23RQ6F4BWFIREȚEI7I2AXBCCF7C3HLCA5UABK',
} as const;

/**
 * Mainnet Asset Issuers
 *
 * Well-known asset issuers on mainnet for production
 */
export const MAINNET_ASSET_ISSUERS = {
  usdc: 'GA5ZSEJYB37JRC5AVCIA5MOP4SHAIF5KVW5WO6YUWT33UKSCT6EPSESM',
  eurc: 'GBBD47UZQ5SYWDRFGWCMA3BKPXZMBTUY3MQQ5DUMPYTSKZPNPS6BUUJM',
} as const;

/**
 * Network-Specific Parameters
 *
 * Parameters that differ between networks
 */
export const NETWORK_PARAMETERS = {
  testnet: {
    baseReserve: 0.5, // stroops
    baseFee: 100, // stroops
    maxTxSize: 1024 * 100, // bytes
    ledgerCloseTime: 5, // seconds
  },
  mainnet: {
    baseReserve: 0.5, // stroops
    baseFee: 100, // stroops
    maxTxSize: 1024 * 100, // bytes
    ledgerCloseTime: 5, // seconds
  },
} as const;

/**
 * Passphrase Validation
 *
 * Ensures passphrases match expected values for each network
 */
export const PASSPHRASE_VALIDATION = {
  testnet: {
    expected: 'Test SDF Network ; September 2015',
    actual: Networks.TESTNET,
  },
  mainnet: {
    expected: 'Public Global Stellar Network ; September 2015',
    actual: Networks.PUBLIC,
  },
} as const;

/**
 * Horizon Endpoint Validation
 *
 * Validates Horizon URLs are correct for each network
 */
export const HORIZON_ENDPOINT_VALIDATION = {
  testnet: {
    url: 'https://horizon-testnet.stellar.org',
    healthCheck: '/health',
  },
  mainnet: {
    url: 'https://horizon.stellar.org',
    healthCheck: '/health',
  },
} as const;

/**
 * Soroban RPC Endpoint Validation
 *
 * Validates Soroban RPC URLs are correct for each network
 */
export const SOROBAN_RPC_ENDPOINT_VALIDATION = {
  testnet: {
    url: 'https://soroban-testnet.stellar.org',
    method: 'getNetwork',
  },
  mainnet: {
    url: 'https://mainnet.stellar.validationcloud.io/v1/soroban/rpc',
    method: 'getNetwork',
  },
} as const;

/**
 * Test Account Fixtures
 *
 * Placeholder accounts for testing (never use real keys)
 */
export const TEST_ACCOUNTS = {
  testnet: {
    publicKey: 'GBUQWP3BOUZX34ULNQG23RQ6F4BWFIRETEI7I2AXBCCF7C3HLCA5UABK',
    // Private key: NEVER include real keys in fixtures
    privateKeyPlaceholder: 'SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  },
  mainnet: {
    publicKey: 'GBUQWP3BOUZX34ULNQG23RQ6F4BWFIRETEI7I2AXBCCF7C3HLCA5UABK',
    // Private key: NEVER include real keys in fixtures
    privateKeyPlaceholder: 'SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  },
} as const;

/**
 * Configuration Divergence Validation
 *
 * Asserts that testnet and mainnet configs share no conflicting values
 */
export function validateNetworkDivergence(): {
  conflicts: string[];
  isValid: boolean;
} {
  const conflicts: string[] = [];

  // Passphrases must be different
  if (TESTNET_CONFIG.networkPassphrase === MAINNET_CONFIG.networkPassphrase) {
    conflicts.push('Network passphrases must differ between testnet and mainnet');
  }

  // Horizon URLs must be different
  if (TESTNET_CONFIG.horizonUrl === MAINNET_CONFIG.horizonUrl) {
    conflicts.push('Horizon URLs must differ between testnet and mainnet');
  }

  // Soroban RPC URLs must be different
  if (TESTNET_CONFIG.sorobanRpcUrl === MAINNET_CONFIG.sorobanRpcUrl) {
    conflicts.push('Soroban RPC URLs must differ between testnet and mainnet');
  }

  // Network names must be different
  if (TESTNET_CONFIG.network === MAINNET_CONFIG.network) {
    conflicts.push('Network names must differ between testnet and mainnet');
  }

  return {
    conflicts,
    isValid: conflicts.length === 0,
  };
}

/**
 * Passphrase Mismatch Detection
 *
 * Validates that passphrase matches the network configuration
 */
export function validatePassphraseMismatch(
  network: 'testnet' | 'mainnet',
  passphrase: string
): { isValid: boolean; error?: string } {
  const expectedPassphrase =
    network === 'testnet' ? Networks.TESTNET : Networks.PUBLIC;

  if (passphrase !== expectedPassphrase) {
    return {
      isValid: false,
      error: `Passphrase mismatch for ${network}: expected "${expectedPassphrase}", got "${passphrase}"`,
    };
  }

  return { isValid: true };
}

/**
 * Configuration Consistency Check
 *
 * Validates that a configuration is internally consistent
 */
export function validateConfigurationConsistency(
  config: StellarNetworkConfig
): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Network name must match passphrase
  if (config.network === 'testnet') {
    if (config.networkPassphrase !== Networks.TESTNET) {
      errors.push('Testnet config has wrong passphrase');
    }
    if (!config.horizonUrl.includes('testnet')) {
      errors.push('Testnet config has wrong Horizon URL');
    }
  } else if (config.network === 'mainnet') {
    if (config.networkPassphrase !== Networks.PUBLIC) {
      errors.push('Mainnet config has wrong passphrase');
    }
    if (config.horizonUrl.includes('testnet')) {
      errors.push('Mainnet config has testnet Horizon URL');
    }
  }

  // URLs must be valid
  if (!config.horizonUrl.startsWith('https://')) {
    errors.push('Horizon URL must use HTTPS');
  }

  if (!config.sorobanRpcUrl.startsWith('https://')) {
    errors.push('Soroban RPC URL must use HTTPS');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

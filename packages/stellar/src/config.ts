import { Networks } from 'stellar-sdk';
import type { StellarNetworkConfig } from '@craft/types';

export const NETWORK_PASSPHRASES = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
} as const;

export const HORIZON_URLS = {
  mainnet: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
} as const;

export const SOROBAN_RPC_URLS = {
  mainnet: 'https://mainnet.stellar.validationcloud.io/v1/soroban/rpc',
  testnet: 'https://soroban-testnet.stellar.org',
} as const;

type Network = 'mainnet' | 'testnet';

function resolveNetwork(): Network {
  const raw = process.env.STELLAR_NETWORK ?? process.env.NEXT_PUBLIC_STELLAR_NETWORK;
  return raw === 'mainnet' ? 'mainnet' : 'testnet';
}

export function getNetworkConfig(network?: Network): StellarNetworkConfig {
  const net = network ?? resolveNetwork();
  return {
    network: net,
    horizonUrl: HORIZON_URLS[net],
    networkPassphrase: NETWORK_PASSPHRASES[net],
    sorobanRpcUrl: SOROBAN_RPC_URLS[net],
  };
}

/**
 * Validates that a transaction's network passphrase matches the target network.
 * Prevents cross-network transaction replay attacks.
 *
 * @param transactionPassphrase - The passphrase used to sign the transaction
 * @param targetNetwork - The target network ('mainnet' or 'testnet')
 * @throws Error if passphrase doesn't match the target network
 *
 * @example
 * ```typescript
 * validateNetworkPassphrase(transaction.networkPassphrase, 'mainnet');
 * ```
 */
export function validateNetworkPassphrase(
  transactionPassphrase: string,
  targetNetwork?: Network
): void {
  const net = targetNetwork ?? resolveNetwork();
  const expectedPassphrase = NETWORK_PASSPHRASES[net];

  if (transactionPassphrase !== expectedPassphrase) {
    throw new Error(
      `Network passphrase mismatch: transaction signed for "${transactionPassphrase}" ` +
      `but target network "${net}" requires "${expectedPassphrase}". ` +
      `This prevents cross-network transaction replay.`
    );
  }
}

/** Default config resolved from environment variables. */
export const config = {
  stellar: getNetworkConfig(),
} as const;

export default config;

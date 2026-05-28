import { Horizon, SorobanRpc, Transaction } from 'stellar-sdk';
import { getNetworkConfig, validateNetworkPassphrase } from './config';
import { parseStellarError, formatError } from './errors';
import type { StellarNetworkConfig } from '@craft/types';

type Network = 'mainnet' | 'testnet';

/**
 * Returns a Horizon server client for the given network.
 * Defaults to the network resolved from environment variables.
 */
export function getHorizonClient(network?: Network): Horizon.Server {
  const { horizonUrl } = getNetworkConfig(network);
  return new Horizon.Server(horizonUrl);
}

/**
 * Returns a Soroban RPC client for the given network.
 * Defaults to the network resolved from environment variables.
 */
export function getSorobanClient(network?: Network): SorobanRpc.Server {
  const { sorobanRpcUrl } = getNetworkConfig(network);
  if (!sorobanRpcUrl) {
    throw new Error(`No Soroban RPC URL configured for network: ${network}`);
  }
  return new SorobanRpc.Server(sorobanRpcUrl);
}

/**
 * Returns both Horizon and Soroban clients together with the resolved config.
 */
export function getNetworkClients(network?: Network): {
  horizon: Horizon.Server;
  soroban: SorobanRpc.Server;
  config: StellarNetworkConfig;
} {
  const cfg = getNetworkConfig(network);
  return {
    horizon: new Horizon.Server(cfg.horizonUrl),
    soroban: new SorobanRpc.Server(cfg.sorobanRpcUrl!),
    config: cfg,
  };
}

// Default server instance (resolved from env at module load)
export const server = getHorizonClient();
export const networkPassphrase = getNetworkConfig().networkPassphrase;

export async function loadAccount(publicKey: string, network?: Network) {
  try {
    return await getHorizonClient(network).loadAccount(publicKey);
  } catch (error) {
    const parsed = parseStellarError(error);
    throw new Error(
      `Failed to load account: ${parsed.message}\n${formatError(error, true)}`
    );
  }
}

export async function getAccountBalance(publicKey: string, network?: Network) {
  try {
    const account = await loadAccount(publicKey, network);
    return account.balances;
  } catch (error) {
    const parsed = parseStellarError(error);
    throw new Error(
      `Failed to get account balance: ${parsed.message}\n${formatError(error, true)}`
    );
  }
}

/**
 * Batch validate multiple Stellar accounts efficiently.
 * Reduces network round trips by batching account validation queries.
 *
 * @param publicKeys - Array of Stellar account public keys to validate
 * @param network - Target network (defaults to environment config)
 * @returns Array of validation results with per-account status
 *
 * @example
 * ```typescript
 * const results = await batchValidateAccounts([
 *   'GABC...', 'GDEF...', 'GHIJ...'
 * ]);
 * results.forEach(r => {
 *   if (r.valid) console.log(`${r.publicKey}: exists`);
 *   else console.log(`${r.publicKey}: ${r.error}`);
 * });
 * ```
 */
export async function batchValidateAccounts(
  publicKeys: string[],
  network?: Network
): Promise<Array<{
  publicKey: string;
  valid: boolean;
  account?: Horizon.ServerApi.AccountRecord;
  error?: string;
}>> {
  const client = getHorizonClient(network);
  
  // Batch requests with Promise.allSettled to handle partial failures
  const results = await Promise.allSettled(
    publicKeys.map(pk => client.loadAccount(pk))
  );

  return results.map((result, index) => {
    const publicKey = publicKeys[index];
    
    if (result.status === 'fulfilled') {
      return {
        publicKey,
        valid: true,
        account: result.value,
      };
    } else {
      const parsed = parseStellarError(result.reason);
      return {
        publicKey,
        valid: false,
        error: parsed.message,
      };
    }
  });
}

export async function submitTransaction(transaction: Transaction, network?: Network) {
  try {
    // Validate network passphrase before submission
    validateNetworkPassphrase(transaction.networkPassphrase, network);
    
    return await getHorizonClient(network).submitTransaction(transaction);
  } catch (error) {
    const parsed = parseStellarError(error, (transaction as any).hash);
    throw new Error(
      `Failed to submit transaction: ${parsed.message}\n${formatError(error, true)}`
    );
  }
}

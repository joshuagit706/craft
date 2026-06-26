import { Networks } from 'stellar-sdk';
import type { StellarNetworkConfig } from '@craft/types';
import { NetworkMismatchError } from './errors';

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
    throw new NetworkMismatchError(transactionPassphrase, expectedPassphrase, net);
  }
}

/** Default config resolved from environment variables. */
export const config = {
  stellar: getNetworkConfig(),
} as const;

export default config;

// ---------------------------------------------------------------------------
// Multi-endpoint Horizon failover (#615)
// ---------------------------------------------------------------------------

/**
 * Configuration for multi-endpoint Horizon failover.
 *
 * ## Failover algorithm
 * 1. The first entry in `endpoints` is the primary.
 * 2. On every request, `selectEndpoint()` returns the first healthy endpoint.
 * 3. An endpoint is marked unhealthy when a request against it throws; it is
 *    re-checked after `recoveryMs` milliseconds (default 30 s).
 * 4. If all endpoints are unhealthy the primary is returned as a last resort
 *    so callers always receive a usable URL.
 *
 * ## Configuration
 * ```ts
 * const failover = createHorizonFailover({
 *   endpoints: ['https://horizon.stellar.org', 'https://horizon.example.com'],
 * });
 * const url = failover.selectEndpoint();
 * // … after a failed request:
 * failover.markUnhealthy(url);
 * ```
 */
export interface HorizonFailoverConfig {
  /** Ordered list of Horizon URLs. First entry is the primary. */
  endpoints: string[];
  /** Milliseconds before an unhealthy endpoint is retried. Default: 30 000. */
  recoveryMs?: number;
}

export interface HorizonFailover {
  /** Returns the best available endpoint (prefers healthy, falls back to primary). */
  selectEndpoint(): string;
  /** Mark an endpoint as unhealthy after a failed request. */
  markUnhealthy(url: string): void;
  /** Mark an endpoint as healthy (called after a successful request). */
  markHealthy(url: string): void;
}

/**
 * Creates a stateful Horizon failover manager.
 *
 * Endpoint health is tracked in memory. The primary endpoint (index 0) is
 * preferred; secondary endpoints are used only when the primary is unhealthy.
 * Recovery is time-based: an endpoint becomes eligible again after `recoveryMs`.
 */
export function createHorizonFailover(cfg: HorizonFailoverConfig): HorizonFailover {
  const { endpoints, recoveryMs = 30_000 } = cfg;
  if (endpoints.length === 0) throw new Error('At least one Horizon endpoint is required');

  // Map<url, unhealthySince (ms timestamp)>
  const unhealthyUntil = new Map<string, number>();

  function isHealthy(url: string): boolean {
    const until = unhealthyUntil.get(url);
    if (until === undefined) return true;
    if (Date.now() >= until) {
      unhealthyUntil.delete(url);
      return true;
    }
    return false;
  }

  return {
    selectEndpoint(): string {
      for (const url of endpoints) {
        if (isHealthy(url)) return url;
      }
      // All unhealthy — return primary as last resort
      return endpoints[0];
    },
    markUnhealthy(url: string): void {
      unhealthyUntil.set(url, Date.now() + recoveryMs);
    },
    markHealthy(url: string): void {
      unhealthyUntil.delete(url);
    },
  };
}

/**
 * Default per-network failover instances built from the standard endpoint lists.
 * Override by calling `createHorizonFailover` with custom endpoint arrays.
 */
export const HORIZON_FAILOVER_ENDPOINTS: Record<Network, string[]> = {
  mainnet: [HORIZON_URLS.mainnet],
  testnet: [HORIZON_URLS.testnet],
};

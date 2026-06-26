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
  // Throws NetworkMismatchError if the transaction's passphrase doesn't match the target network
  validateNetworkPassphrase(transaction.networkPassphrase, network);
  try {
    return await getHorizonClient(network).submitTransaction(transaction);
  } catch (error) {
    const parsed = parseStellarError(error, (transaction as any).hash);
    throw new Error(
      `Failed to submit transaction: ${parsed.message}\n${formatError(error, true)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Transaction Sequencing with Conflict Resolution (#624)
// ---------------------------------------------------------------------------

/**
 * Returns true when the submission error represents a sequence number conflict
 * (tx_bad_seq / bad_seq Horizon result codes).
 */
export function isSequenceConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('tx_bad_seq') ||
    msg.includes('bad_seq') ||
    msg.includes('txbadseq') ||
    // Horizon response body sometimes surfaces this via extras
    msg.includes('sequence number')
  );
}

/**
 * Manages per-account sequence numbers in memory and refreshes them from
 * Horizon when a conflict is detected.
 *
 * Usage:
 *  1. Call `getSequence` to obtain the current sequence number.
 *  2. Build the transaction using that sequence number.
 *  3. On successful submission call `increment`.
 *  4. On sequence conflict call `refresh` then retry.
 */
export class SequenceManager {
  private readonly sequences = new Map<string, number>();

  /** Returns the cached sequence number, fetching it from Horizon on first access. */
  async getSequence(accountId: string, horizon: Horizon.Server): Promise<number> {
    if (!this.sequences.has(accountId)) {
      await this.refresh(accountId, horizon);
    }
    return this.sequences.get(accountId)!;
  }

  /** Increments the cached sequence number after a successful submission. */
  increment(accountId: string): void {
    const current = this.sequences.get(accountId) ?? 0;
    this.sequences.set(accountId, current + 1);
  }

  /** Fetches the current sequence number from Horizon and updates the cache. */
  async refresh(accountId: string, horizon: Horizon.Server): Promise<number> {
    const account = await horizon.loadAccount(accountId);
    const seq = parseInt((account as any).sequence ?? account.sequenceNumber(), 10);
    this.sequences.set(accountId, seq);
    return seq;
  }

  /** Clears the cached sequence for one account, or all accounts when omitted. */
  clear(accountId?: string): void {
    if (accountId !== undefined) {
      this.sequences.delete(accountId);
    } else {
      this.sequences.clear();
    }
  }
}

export const defaultSequenceManager = new SequenceManager();

/**
 * Submits a transaction built by `buildTransaction`, automatically detecting
 * sequence number conflicts and retrying with a refreshed sequence.
 *
 * Sequencing strategy:
 *  - On first attempt the cached (or freshly fetched) sequence is used.
 *  - When a tx_bad_seq conflict is returned, the sequence is refreshed from
 *    Horizon and the transaction is rebuilt and resubmitted (up to maxRetries).
 *  - On concurrent submission scenarios the account sequence is re-read each
 *    retry so the corrected value is always authoritative.
 *
 * @param accountId        - Public key of the source account.
 * @param buildTransaction - Factory called with the current sequence number.
 * @param network          - Optional network override.
 * @param _manager         - Optional SequenceManager override (for testing).
 * @param maxRetries       - Number of conflict-resolution retries (default 1).
 */
export async function submitWithSequenceRetry(
  accountId: string,
  buildTransaction: (sequenceNumber: number) => Transaction,
  network?: Network,
  _manager: SequenceManager = defaultSequenceManager,
  maxRetries = 1,
): Promise<Awaited<ReturnType<Horizon.Server['submitTransaction']>>> {
  const horizon = getHorizonClient(network);
  let attempt = 0;

  while (true) {
    const seq = await _manager.getSequence(accountId, horizon);
    const tx = buildTransaction(seq);
    // Throws NetworkMismatchError before any network call if the passphrase is wrong
    validateNetworkPassphrase(tx.networkPassphrase, network);
    try {
      const result = await horizon.submitTransaction(tx);
      _manager.increment(accountId);
      return result;
    } catch (error) {
      if (isSequenceConflict(error) && attempt < maxRetries) {
        attempt++;
        await _manager.refresh(accountId, horizon);
        continue;
      }
      const parsed = parseStellarError(error, (tx as any).hash?.());
      throw new Error(
        `Failed to submit transaction: ${parsed.message}\n${formatError(error, true)}`,
      );
    }
  }
}

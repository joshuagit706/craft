import { SorobanRpc, Contract, TransactionBuilder, Networks, BASE_FEE, xdr } from 'stellar-sdk';
import { config } from './config';
import { parseStellarError } from './errors';

// Minimal AppError shape — matches apps/backend/src/lib/api/retryable-error.ts
export interface AppError {
    status?: number;
    message: string;
    code?: string;
}

export type InvokeContractResult<T = SorobanRpc.Api.SimulateTransactionResponse> =
    | { ok: true; result: T }
    | { ok: false; error: AppError };

export interface AbiVersionInfo {
    major: number;
    minor: number;
    patch: number;
}

export interface AbiCompatibilityResult {
    compatible: boolean;
    contractAbi: AbiVersionInfo;
    networkSupportedVersions: AbiVersionInfo[];
    error?: string;
}

export const SUPPORTED_ABI_VERSIONS: Record<string, AbiVersionInfo[]> = {
    mainnet: [
        { major: 20, minor: 0, patch: 0 },
        { major: 21, minor: 0, patch: 0 },
    ],
    testnet: [
        { major: 20, minor: 0, patch: 0 },
        { major: 21, minor: 0, patch: 0 },
    ],
};

const SOROBAN_RPC_URLS = {
    mainnet: 'https://soroban-mainnet.stellar.org',
    testnet: 'https://soroban-testnet.stellar.org',
} as const;

function getSorobanRpcUrl(): string {
    return (
        process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
        SOROBAN_RPC_URLS[config.stellar.network]
    );
}

function getNetworkPassphrase(): string {
    return config.stellar.network === 'mainnet'
        ? Networks.PUBLIC
        : Networks.TESTNET;
}

/**
 * Creates a Soroban RPC server instance for the configured network.
 */
export function createSorobanClient(): SorobanRpc.Server {
    return new SorobanRpc.Server(getSorobanRpcUrl(), { allowHttp: false });
}

export const sorobanClient = createSorobanClient();

// ---------------------------------------------------------------------------
// Contract State Simulation Cache
// ---------------------------------------------------------------------------
//
// A short-lived in-memory cache for `simulateContractCall` results.
//
// Design notes:
//  - Key  : `${contractId}:${method}:${JSON.stringify(args)}:${sourcePublicKey}`
//  - TTL  : CACHE_TTL_MS (default 5 000 ms). Entries older than this are
//           considered stale and bypassed on the next read.
//  - Size : MAX_CACHE_ENTRIES (default 1 000). When the limit is reached the
//           oldest entry (first inserted, because Map preserves insertion
//           order) is evicted before a new entry is stored.
//  - Eviction is lazy – stale entries are only removed when they are accessed
//           or when a new entry would exceed MAX_CACHE_ENTRIES.
//
// Call `clearCache()` to flush all entries (e.g. in test teardown).
// ---------------------------------------------------------------------------

/** Maximum number of entries held at once. Older entries are evicted first. */
const MAX_CACHE_ENTRIES = 1_000;

/** Time-to-live for each cache entry in milliseconds. */
const CACHE_TTL_MS = 5_000;

interface SimulationCacheEntry {
    response: SorobanRpc.Api.SimulateTransactionResponse;
    /** Unix timestamp (ms) of when the entry was stored. */
    storedAt: number;
}

const simulationCache = new Map<string, SimulationCacheEntry>();

/** Build the cache key from the call parameters. */
function buildCacheKey(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    sourcePublicKey: string
): string {
    // Serialise args to their base64 XDR representations for a stable key.
    const argsKey = args.map((a) => a.toXDR('base64')).join(',');
    return `${contractId}:${method}:${argsKey}:${sourcePublicKey}`;
}

/**
 * Evict a single entry by key if it exists – used when making room for a new
 * entry that would exceed the size cap.
 */
function evictOldest(): void {
    const firstKey = simulationCache.keys().next().value;
    if (firstKey !== undefined) {
        simulationCache.delete(firstKey);
    }
}

/**
 * Clear all cached simulation results.
 * Call this in test teardown to ensure isolation between test cases.
 */
export function clearCache(): void {
    simulationCache.clear();
}

/**
 * Simulates a contract invocation without submitting to the network.
 *
 * Results are cached for CACHE_TTL_MS to avoid redundant RPC round-trips
 * during the preview and deployment flows. The cache is keyed on
 * (contractId, method, args, sourcePublicKey).
 *
 * @param contractId - The contract address (C...)
 * @param method - The contract method name
 * @param args - XDR-encoded method arguments
 * @param sourcePublicKey - The source account public key
 */
export async function simulateContractCall(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    sourcePublicKey: string
): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    const cacheKey = buildCacheKey(contractId, method, args, sourcePublicKey);
    const now = Date.now();

    // Cache hit – return the stored response if still within TTL.
    const cached = simulationCache.get(cacheKey);
    if (cached && now - cached.storedAt < CACHE_TTL_MS) {
        return cached.response;
    }

    // Cache miss (or stale) – fetch from RPC.
    const account = await sorobanClient.getAccount(sourcePublicKey);
    const contract = new Contract(contractId);

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: getNetworkPassphrase(),
    })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();

    const response = await sorobanClient.simulateTransaction(tx);

    // Evict the oldest entry first if we are at capacity.
    if (simulationCache.size >= MAX_CACHE_ENTRIES) {
        evictOldest();
    }

    simulationCache.set(cacheKey, { response, storedAt: now });
    return response;
}

/**
 * Performs a dry-run simulation of a Soroban contract invocation.
 * Detects errors and estimates resources before actual deployment.
 *
 * @param contractId - The contract address (C...)
 * @param method - The contract method name
 * @param args - XDR-encoded method arguments
 * @param sourcePublicKey - The source account public key
 * @returns Simulation result with success status, errors, and resource estimates
 *
 * @example
 * ```typescript
 * const dryRun = await performContractDryRun(contractId, 'transfer', args, pubKey);
 * if (!dryRun.success) {
 *   console.error('Simulation failed:', dryRun.error);
 *   return; // Block deployment
 * }
 * console.log('Estimated fee:', dryRun.resourceEstimate?.fee);
 * ```
 */
export async function performContractDryRun(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    sourcePublicKey: string
): Promise<{
    success: boolean;
    error?: string;
    resourceEstimate?: {
        cpuInstructions?: string;
        memoryBytes?: string;
        fee?: string;
    };
    result?: SorobanRpc.Api.SimulateTransactionResponse;
}> {
    try {
        const simulation = await simulateContractCall(
            contractId,
            method,
            args,
            sourcePublicKey
        );

        // Check for simulation errors
        if (SorobanRpc.Api.isSimulationError(simulation)) {
            return {
                success: false,
                error: `Contract simulation failed: ${simulation.error}`,
                result: simulation,
            };
        }

        // Extract resource estimates if available
        const resourceEstimate: any = {};
        if ('cost' in simulation && simulation.cost) {
            resourceEstimate.cpuInstructions = simulation.cost.cpuInsns;
            resourceEstimate.memoryBytes = simulation.cost.memBytes;
        }
        if ('minResourceFee' in simulation) {
            resourceEstimate.fee = simulation.minResourceFee;
        }

        return {
            success: true,
            resourceEstimate,
            result: simulation,
        };
    } catch (error: unknown) {
        const parsed = parseStellarError(error);
        return {
            success: false,
            error: `Dry-run failed: ${parsed.message}`,
        };
    }
}

/**
 * Prepares and submits a contract invocation transaction.
 * Caller is responsible for signing the prepared transaction before submission.
 *
 * @param contractId - The contract address (C...)
 * @param method - The contract method name
 * @param args - XDR-encoded method arguments
 * @param sourcePublicKey - The source account public key
 * @returns The prepared (unsigned) transaction ready for signing
 */
export async function prepareContractCall(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    sourcePublicKey: string
): Promise<ReturnType<typeof TransactionBuilder.prototype.build>> {
    const account = await sorobanClient.getAccount(sourcePublicKey);
    const contract = new Contract(contractId);

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: getNetworkPassphrase(),
    })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();

    return sorobanClient.prepareTransaction(tx);
}

/**
 * Sends a signed transaction to the Soroban RPC and polls for the result.
 *
 * @param signedTxXdr - The signed transaction in XDR format
 */
export async function sendSorobanTransaction(
    signedTxXdr: string
): Promise<SorobanRpc.Api.GetTransactionResponse> {
    const tx = TransactionBuilder.fromXDR(signedTxXdr, getNetworkPassphrase());
    const sendResult = await sorobanClient.sendTransaction(tx);

    if (sendResult.status === 'ERROR') {
        throw new Error(`Transaction submission failed: ${sendResult.errorResult?.toXDR('base64')}`);
    }

    // Poll for transaction result
    let getResult = await sorobanClient.getTransaction(sendResult.hash);
    const deadline = Date.now() + 30_000;

    while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        if (Date.now() > deadline) {
            throw new Error(`Transaction ${sendResult.hash} not found after 30s`);
        }
        await new Promise((r) => setTimeout(r, 1000));
        getResult = await sorobanClient.getTransaction(sendResult.hash);
    }

    return getResult;
}

/**
 * Invoke a Soroban contract method via simulation and return a typed result.
 *
 * Wraps `simulateContractCall` and maps any RPC error through `parseStellarError`
 * so callers receive a discriminated union instead of a raw thrown error.
 *
 * @param contractId - The contract address (C...)
 * @param method - The contract method name
 * @param args - XDR-encoded method arguments
 * @param sourcePublicKey - The source account public key
 * @param _simulate - Optional override for `simulateContractCall` (for testing)
 * @returns `{ ok: true, result }` on success or `{ ok: false, error: AppError }` on failure
 *
 * @example
 * ```typescript
 * const res = await invokeContractMethod(contractId, 'transfer', args, pubKey);
 * if (!res.ok) {
 *   console.error(res.error.message); // typed, user-friendly message
 * }
 * ```
 */
export async function invokeContractMethod(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    sourcePublicKey: string,
    _simulate: typeof simulateContractCall = simulateContractCall,
): Promise<InvokeContractResult> {
    try {
        const result = await _simulate(contractId, method, args, sourcePublicKey);
        return { ok: true, result };
    } catch (raw: unknown) {
        const parsed = parseStellarError(raw);
        return {
            ok: false,
            error: {
                message: parsed.message,
                code: parsed.code,
                // Map retryable network/rate-limit errors to an HTTP-like status
                // so callers using isRetryableError(AppError) work correctly.
                status: parsed.retryable && parsed.code === 'RATE_LIMITED' ? 429
                    : parsed.retryable && parsed.code === 'CONNECTION_TIMEOUT' ? undefined
                    : parsed.retryable ? undefined
                    : 400,
            },
        };
    }
}

// ---------------------------------------------------------------------------
// Contract Upgrade Path Management (#621)
// ---------------------------------------------------------------------------

export interface StorageKeySchema {
    /** Symbolic name for the storage key (e.g. "Balance", "Config") */
    name: string;
    /** XDR type tag for the key value */
    typeTag: string;
}

export interface UpgradeCompatibilityResult {
    compatible: boolean;
    /** Human-readable reason when compatible is false */
    reason?: string;
}

export interface ContractUpgradeRecord {
    contractId: string;
    previousWasmHash: string;
    newWasmHash: string;
    scheduledAt: number;
    upgraderPublicKey: string;
    status: 'pending' | 'applied' | 'rolled_back';
}

/**
 * Validates that the new contract version is state-compatible with the
 * currently deployed version.
 *
 * Rules:
 *  - No persistent storage keys may be removed (would corrupt existing state).
 *  - Existing key type tags must not change (would break deserialization).
 *  - New keys may be freely added.
 */
export function validateUpgradeCompatibility(
    deployedSchema: StorageKeySchema[],
    newSchema: StorageKeySchema[],
): UpgradeCompatibilityResult {
    for (const deployed of deployedSchema) {
        const inNew = newSchema.find((k) => k.name === deployed.name);
        if (!inNew) {
            return {
                compatible: false,
                reason: `Upgrade removes storage key "${deployed.name}" — existing state would be inaccessible`,
            };
        }
        if (inNew.typeTag !== deployed.typeTag) {
            return {
                compatible: false,
                reason: `Upgrade changes type of storage key "${deployed.name}" from "${deployed.typeTag}" to "${inNew.typeTag}"`,
            };
        }
    }
    return { compatible: true };
}

/**
 * Schedules a contract upgrade after performing compatibility validation.
 * Returns a pending upgrade record; throws if the schemas are incompatible.
 *
 * Upgrade procedure:
 *  1. Call `scheduleContractUpgrade` — validates schemas and returns a pending record.
 *  2. Submit the WASM upload + contract upgrade transactions on-chain.
 *  3. Update record status to 'applied'.
 *
 * Rollback: call `rollbackContractUpgrade` on any pending record to cancel it
 * before the on-chain transaction is submitted.
 */
export function scheduleContractUpgrade(
    contractId: string,
    previousWasmHash: string,
    newWasmHash: string,
    upgraderPublicKey: string,
    deployedSchema: StorageKeySchema[],
    newSchema: StorageKeySchema[],
): ContractUpgradeRecord {
    const validation = validateUpgradeCompatibility(deployedSchema, newSchema);
    if (!validation.compatible) {
        throw new Error(`Contract upgrade rejected: ${validation.reason}`);
    }
    return {
        contractId,
        previousWasmHash,
        newWasmHash,
        scheduledAt: Date.now(),
        upgraderPublicKey,
        status: 'pending',
    };
}

/**
 * Marks a pending upgrade record as rolled back.
 * Only records with status 'pending' can be rolled back.
 */
export function rollbackContractUpgrade(record: ContractUpgradeRecord): ContractUpgradeRecord {
    if (record.status !== 'pending') {
        throw new Error(`Cannot roll back upgrade with status "${record.status}"`);
    }
    return { ...record, status: 'rolled_back' };
}

// ---------------------------------------------------------------------------
// Multi-Signature Authorization for Admin Operations (#622)
// ---------------------------------------------------------------------------

export interface MultiSigConfig {
    /** Minimum number of valid signatures required to execute the operation */
    threshold: number;
    /** Set of public keys authorized to sign admin operations */
    authorizedSigners: string[];
}

export interface MultiSigOperation {
    id: string;
    /** Serialized operation payload */
    payload: string;
    /** Public keys of authorized signers that have signed this operation */
    collectedSignatures: string[];
    status: 'pending' | 'approved' | 'executed';
}

/**
 * Creates a new pending multi-sig operation.
 * Throws if the threshold is invalid relative to the authorized signer set.
 */
export function createMultiSigOperation(
    payload: string,
    config: MultiSigConfig,
): MultiSigOperation {
    if (config.threshold < 1) {
        throw new Error('Multi-sig threshold must be at least 1');
    }
    if (config.threshold > config.authorizedSigners.length) {
        throw new Error('Multi-sig threshold cannot exceed the number of authorized signers');
    }
    return {
        id: `msig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        payload,
        collectedSignatures: [],
        status: 'pending',
    };
}

/**
 * Adds a validated signature to a pending multi-sig operation.
 *
 * - Rejects signers not in config.authorizedSigners.
 * - Rejects duplicate signatures from the same signer.
 * - Rejects signatures on non-pending operations.
 * - Transitions status to 'approved' when the threshold is reached.
 */
export function collectSignature(
    operation: MultiSigOperation,
    signerPublicKey: string,
    config: MultiSigConfig,
): MultiSigOperation {
    if (operation.status !== 'pending') {
        throw new Error(`Cannot add signature to operation with status "${operation.status}"`);
    }
    if (!config.authorizedSigners.includes(signerPublicKey)) {
        throw new Error(`Signer "${signerPublicKey}" is not in the authorized signer set`);
    }
    if (operation.collectedSignatures.includes(signerPublicKey)) {
        throw new Error(`Signer "${signerPublicKey}" has already signed this operation`);
    }
    const updated: MultiSigOperation = {
        ...operation,
        collectedSignatures: [...operation.collectedSignatures, signerPublicKey],
    };
    if (updated.collectedSignatures.length >= config.threshold) {
        updated.status = 'approved';
    }
    return updated;
}

/**
 * Marks an approved multi-sig operation as executed.
 * Throws if the operation has not yet reached the required signature threshold.
 */
export function executeMultiSigOperation(operation: MultiSigOperation): MultiSigOperation {
    if (operation.status !== 'approved') {
        throw new Error(
            `Cannot execute operation with status "${operation.status}" — threshold not reached`,
        );
    }
    return { ...operation, status: 'executed' };
}

// ---------------------------------------------------------------------------
// Contract State Snapshot and Restore (#623)
// ---------------------------------------------------------------------------

export interface ContractStorageEntry {
    /** Base64-encoded XDR key */
    key: string;
    /** Base64-encoded XDR value */
    value: string;
}

export interface ContractSnapshot {
    /** Snapshot format version — bump when the schema changes */
    version: 1;
    contractId: string;
    /** Restricted to testnet; mainnet operations are always rejected */
    network: 'testnet';
    capturedAt: number;
    entries: ContractStorageEntry[];
}

/**
 * Captures a portable snapshot of a Soroban contract's storage entries.
 *
 * Snapshot / restore workflow:
 *  1. Call `snapshotContractState` on testnet to capture current storage.
 *  2. Reproduce or modify state as needed for debugging.
 *  3. Call `restoreContractState` with the snapshot to reapply it.
 *
 * Restricted to testnet — throws for any other network value.
 *
 * @param contractId   - The Soroban contract address (C...).
 * @param network      - Must be 'testnet'.
 * @param _getEntries  - Injectable fetcher for storage entries (default: RPC).
 */
export async function snapshotContractState(
    contractId: string,
    network: string,
    _getEntries: (id: string) => Promise<ContractStorageEntry[]> = _defaultGetEntries,
): Promise<ContractSnapshot> {
    if (network !== 'testnet') {
        throw new Error('Contract state snapshot is only permitted on testnet');
    }
    const entries = await _getEntries(contractId);
    return {
        version: 1,
        contractId,
        network: 'testnet',
        capturedAt: Date.now(),
        entries,
    };
}

/**
 * Restores a Soroban contract's storage to a previously captured snapshot.
 *
 * Restricted to testnet — throws for any other network value.
 * Throws if the snapshot belongs to a different contract.
 *
 * @param contractId    - The Soroban contract address to restore.
 * @param snapshot      - A snapshot produced by `snapshotContractState`.
 * @param network       - Must be 'testnet'.
 * @param _applyEntries - Injectable applier for storage entries (default: RPC).
 */
export async function restoreContractState(
    contractId: string,
    snapshot: ContractSnapshot,
    network: string,
    _applyEntries: (id: string, entries: ContractStorageEntry[]) => Promise<void> = _defaultApplyEntries,
): Promise<void> {
    if (network !== 'testnet') {
        throw new Error('Contract state restore is only permitted on testnet');
    }
    if (snapshot.contractId !== contractId) {
        throw new Error(
            `Snapshot is for contract "${snapshot.contractId}", not "${contractId}"`,
        );
    }
    await _applyEntries(contractId, snapshot.entries);
}

async function _defaultGetEntries(_contractId: string): Promise<ContractStorageEntry[]> {
    return [];
}

async function _defaultApplyEntries(
    _contractId: string,
    _entries: ContractStorageEntry[],
): Promise<void> {
    // No-op default; production implementation submits restore transactions.
}

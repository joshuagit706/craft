import { SorobanRpc, Contract, TransactionBuilder, Networks, BASE_FEE, xdr, hash, StrKey } from 'stellar-sdk';
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
// #613 — Deterministic Contract Address Derivation
// ---------------------------------------------------------------------------
//
// Soroban derives a contract address deterministically from three inputs:
//   deployer  – the deploying account's public key (G… address)
//   salt      – a 32-byte random value chosen by the deployer
//   wasmHash  – the SHA-256 hash of the uploaded WASM binary
//
// Algorithm (mirrors the Soroban host implementation):
//   1. Build an XDR `HashIDPreimage` of type `CONTRACT_ID` containing a
//      `PreimageFromAddress` variant with the deployer address and salt.
//   2. SHA-256 hash the serialised preimage → 32-byte contract ID.
//   3. Encode the contract ID as a Stellar contract address (C… strkey).
//
// Reference: https://github.com/stellar/stellar-xdr (HashIDPreimage)

/**
 * Derive the deterministic Soroban contract address from deployment parameters.
 *
 * The derived address matches the address that Soroban assigns when the
 * contract is deployed with the same `deployer`, `salt`, and `wasmHash`.
 * Use this to preview the contract address before submitting the deployment
 * transaction.
 *
 * @param deployerPublicKey - G… Stellar public key of the deploying account
 * @param salt - 32-byte deployment salt (Buffer or hex string)
 * @param wasmHash - 32-byte SHA-256 hash of the WASM binary (Buffer or hex string)
 * @returns The C… contract address string
 *
 * @example
 * ```ts
 * const address = deriveContractAddress(deployerKey, salt, wasmHash);
 * console.log('Pre-deployment address:', address);
 * ```
 */
export function deriveContractAddress(
    deployerPublicKey: string,
    salt: Buffer | string,
    wasmHash: Buffer | string,
): string {
    const saltBuf = typeof salt === 'string' ? Buffer.from(salt, 'hex') : salt;
    const wasmHashBuf = typeof wasmHash === 'string' ? Buffer.from(wasmHash, 'hex') : wasmHash;

    if (saltBuf.length !== 32) throw new Error('salt must be 32 bytes');
    if (wasmHashBuf.length !== 32) throw new Error('wasmHash must be 32 bytes');

    // Decode the deployer G… address to raw 32-byte public key
    const deployerRaw = StrKey.decodeEd25519PublicKey(deployerPublicKey);

    // Build HashIDPreimage for CONTRACT_ID (preimage_from_address variant)
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
        new xdr.HashIdPreimageContractId({
            networkId: hash(Buffer.from(getNetworkPassphrase())),
            contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
                new xdr.ContractIdPreimageFromAddress({
                    address: xdr.ScAddress.scAddressTypeAccount(
                        xdr.AccountId.publicKeyTypeEd25519(deployerRaw),
                    ),
                    salt: saltBuf,
                }),
            ),
        }),
    );

    const contractId = hash(preimage.toXDR());
    return StrKey.encodeContract(contractId);
}

/**
 * Verify that a derived address matches the address of a deployed contract.
 *
 * @param deployerPublicKey - G… public key used during deployment
 * @param salt - 32-byte salt used during deployment
 * @param wasmHash - 32-byte WASM hash used during deployment
 * @param deployedAddress - The C… address returned after deployment
 * @returns `true` if the derived address matches the deployed address
 */
export function verifyContractAddress(
    deployerPublicKey: string,
    salt: Buffer | string,
    wasmHash: Buffer | string,
    deployedAddress: string,
): boolean {
    return deriveContractAddress(deployerPublicKey, salt, wasmHash) === deployedAddress;
}

// ---------------------------------------------------------------------------
// #614 — Type-Safe Contract Invocation Wrapper with Error Boundary
// ---------------------------------------------------------------------------
//
// `invokeContract<TArgs, TReturn>` provides compile-time type checking for
// contract arguments and return values. All RPC errors are caught and mapped
// through `parseStellarError` so raw RPC details never leak to callers.

/** Typed contract argument descriptor. */
export interface ContractInvokeOptions<TArgs extends xdr.ScVal[]> {
    contractId: string;
    method: string;
    args: TArgs;
    sourcePublicKey: string;
}

/** Typed result of a contract invocation. */
export type TypedInvokeResult<TReturn> =
    | { ok: true; result: TReturn }
    | { ok: false; error: AppError };

/**
 * Type-safe Soroban contract invocation wrapper with error boundary.
 *
 * Accepts a typed `parse` function that converts the raw simulation response
 * into the expected return type `TReturn`. Any error thrown during invocation
 * or parsing is caught and mapped to a typed `AppError` — raw RPC errors
 * never propagate to callers.
 *
 * @param options - Typed invocation options
 * @param parse - Function that extracts `TReturn` from the simulation response
 * @param _simulate - Optional override for `simulateContractCall` (for testing)
 * @returns Discriminated union `{ ok: true, result }` | `{ ok: false, error }`
 *
 * @example
 * ```ts
 * const res = await invokeContract(
 *   { contractId, method: 'balance', args: [addressArg], sourcePublicKey },
 *   (r) => (r as any).result?.retval,
 * );
 * if (res.ok) console.log(res.result);
 * ```
 */
export async function invokeContract<TArgs extends xdr.ScVal[], TReturn>(
    options: ContractInvokeOptions<TArgs>,
    parse: (raw: SorobanRpc.Api.SimulateTransactionResponse) => TReturn,
    _simulate: typeof simulateContractCall = simulateContractCall,
): Promise<TypedInvokeResult<TReturn>> {
    try {
        const raw = await _simulate(
            options.contractId,
            options.method,
            options.args,
            options.sourcePublicKey,
        );
        return { ok: true, result: parse(raw) };
    } catch (err: unknown) {
        const parsed = parseStellarError(err);
        return {
            ok: false,
            error: {
                message: parsed.message,
                code: parsed.code,
                status:
                    parsed.code === 'RATE_LIMITED' ? 429
                    : parsed.code === 'ENDPOINT_UNREACHABLE' ? 503
                    : undefined,
            },
        };
    }
}

// ---------------------------------------------------------------------------
// #616 — Storage Key Namespace Collision Detection
// ---------------------------------------------------------------------------
//
// Template-generated contracts receive storage key prefixes derived from their
// configuration. Two contracts (or two features within one contract) collide
// when their key prefixes are identical, which would corrupt shared state.
//
// Detection is purely static: keys are analysed before deployment so
// collisions are surfaced as configuration errors, not runtime failures.

/** A named storage key entry used for collision analysis. */
export interface StorageKeyEntry {
    /** Human-readable owner label (e.g. template name or feature name). */
    owner: string;
    /** The storage key string (namespace prefix or full key). */
    key: string;
}

/** Describes a detected storage key collision. */
export interface StorageKeyCollision {
    key: string;
    owners: string[];
}

/** Thrown when one or more storage key collisions are detected. */
export class StorageKeyCollisionError extends Error {
    readonly collisions: StorageKeyCollision[];

    constructor(collisions: StorageKeyCollision[]) {
        const summary = collisions
            .map((c) => `"${c.key}" (used by: ${c.owners.join(', ')})`)
            .join('; ');
        super(`Storage key namespace collision detected: ${summary}`);
        this.name = 'StorageKeyCollisionError';
        this.collisions = collisions;
    }
}

/**
 * Detect storage key namespace collisions across a set of key entries.
 *
 * Returns an array of collisions (empty if none). Each collision lists the
 * conflicting key and all owners that claim it.
 *
 * @param entries - Array of `{ owner, key }` pairs to analyse
 * @returns Array of `StorageKeyCollision` objects (empty when no collisions)
 *
 * @example
 * ```ts
 * const collisions = detectStorageKeyCollisions([
 *   { owner: 'TokenA', key: 'balance' },
 *   { owner: 'TokenB', key: 'balance' }, // collision!
 * ]);
 * ```
 */
export function detectStorageKeyCollisions(entries: StorageKeyEntry[]): StorageKeyCollision[] {
    const keyMap = new Map<string, string[]>();
    for (const { owner, key } of entries) {
        const owners = keyMap.get(key) ?? [];
        owners.push(owner);
        keyMap.set(key, owners);
    }
    const collisions: StorageKeyCollision[] = [];
    for (const [key, owners] of keyMap) {
        if (owners.length > 1) collisions.push({ key, owners });
    }
    return collisions;
}

/**
 * Assert that no storage key collisions exist, throwing `StorageKeyCollisionError`
 * if any are found. Use this as a pre-deployment guard.
 *
 * @param entries - Array of `{ owner, key }` pairs to validate
 * @throws `StorageKeyCollisionError` when collisions are detected
 *
 * @example
 * ```ts
 * assertNoStorageKeyCollisions(templateKeys); // throws on collision
 * ```
 */
export function assertNoStorageKeyCollisions(entries: StorageKeyEntry[]): void {
    const collisions = detectStorageKeyCollisions(entries);
    if (collisions.length > 0) throw new StorageKeyCollisionError(collisions);
}

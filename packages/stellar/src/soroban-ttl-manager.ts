/**
 * Soroban Contract Ledger Entry TTL Management (Issue #092)
 *
 * Tracks the time-to-live (TTL) of persistent Soroban ledger entries and
 * automatically builds TTL extension transactions before they expire.
 *
 * ## Background
 * Soroban persistent storage entries carry a `liveUntilLedgerSeq` value.
 * Once `currentLedger > liveUntilLedgerSeq` the entry is archived and no
 * longer accessible without a restore operation.  With ~5 s per ledger,
 * 1 000 remaining ledgers is approximately 83 minutes of runway.
 *
 * ## Flow
 * 1. Call `getLedgerEntryTtl` with a list of ledger keys.
 * 2. Inspect `isNearExpiration` / `isExpired` on each result.
 * 3. Pass at-risk keys to `buildTtlExtensionTransaction` to obtain a
 *    prepared, unsigned transaction that extends their TTL.
 * 4. Sign and submit the prepared transaction via `sendSorobanTransaction`.
 *
 * ## High-level helper
 * `checkContractTtl(contractId)` wraps steps 1–3 for the common case of
 * managing a contract's own instance entry.
 *
 * @see https://developers.stellar.org/docs/smart-contracts/storage-and-ttl
 */

import {
    SorobanRpc,
    xdr,
    Contract,
    TransactionBuilder,
    Operation,
    Networks,
    BASE_FEE,
    SorobanDataBuilder,
} from 'stellar-sdk';
import { config } from './config';
import { parseStellarError } from './errors';

// ── Defaults ──────────────────────────────────────────────────────────────────

/**
 * Warn when fewer than this many ledgers remain on an entry.
 * ~1 000 ledgers ≈ 83 minutes at 5 s/ledger.
 */
export const DEFAULT_WARNING_LEDGERS = 1_000;

/**
 * Target live-until value expressed as ledgers **from now** when extending TTL.
 * ~172 800 ledgers ≈ 1 week at 5 s/ledger.
 */
export const DEFAULT_EXTEND_TO_LEDGERS = 172_800;

// ── Public types ──────────────────────────────────────────────────────────────

export interface TtlThresholds {
    /** Remaining-ledger count below which an entry is considered near expiration. */
    warningLedgers?: number;
    /** How many ledgers from now to extend an at-risk entry's TTL to. */
    extendToLedgers?: number;
}

export interface LedgerEntryTtlInfo {
    key: xdr.LedgerKey;
    /** Ledger sequence after which the entry is archived, or null if unavailable. */
    liveUntilLedger: number | null;
    /** Sequence number of the latest ledger at query time. */
    currentLedger: number;
    /** Remaining ledgers = liveUntilLedger − currentLedger, or null. */
    remainingLedgers: number | null;
    /** true when liveUntilLedger <= currentLedger (entry has expired). */
    isExpired: boolean;
    /** true when remainingLedgers <= warningLedgers (entry is at risk). */
    isNearExpiration: boolean;
}

export interface ContractTtlStatus {
    contractId: string;
    /** TTL info for the contract's own instance entry. */
    instanceTtl: LedgerEntryTtlInfo;
    /** Prepared unsigned transaction XDR for TTL extension, or null when not needed. */
    extensionTxXdr: string | null;
}

export type TtlCheckResult =
    | { ok: true; status: ContractTtlStatus }
    | { ok: false; error: string };

// ── Ledger key helpers ────────────────────────────────────────────────────────

/**
 * Build the `LedgerKey` for a Soroban contract's own instance entry.
 * This is the key under which the contract's WASM hash and storage are held.
 *
 * @param contractId - The contract address (C...)
 */
export function buildContractInstanceKey(contractId: string): xdr.LedgerKey {
    return new Contract(contractId).getFootprint();
}

/**
 * Build a `LedgerKey` for a named persistent contract data entry.
 *
 * @param contractId - The contract address (C...)
 * @param storageKey - The `ScVal` used as the storage key inside the contract
 */
export function buildContractDataKey(contractId: string, storageKey: xdr.ScVal): xdr.LedgerKey {
    const contract = new Contract(contractId);
    return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
            contract: contract.address().toScAddress(),
            key: storageKey,
            durability: xdr.ContractDataDurability.persistent(),
        }),
    );
}

// ── TTL query ─────────────────────────────────────────────────────────────────

/**
 * Query the current TTL for each ledger key and classify entries as
 * near-expiration, expired, or healthy.
 *
 * @param keys - Ledger keys to inspect
 * @param thresholds - Optional TTL classification thresholds
 * @param client - Optional Soroban RPC client override (for testing)
 * @returns One `LedgerEntryTtlInfo` per key in the same order
 */
export async function getLedgerEntryTtl(
    keys: xdr.LedgerKey[],
    thresholds: TtlThresholds = {},
    client: Pick<SorobanRpc.Server, 'getLedgerEntries' | 'getLatestLedger'> = new SorobanRpc.Server(
        getSorobanRpcUrl(),
        { allowHttp: false },
    ),
): Promise<LedgerEntryTtlInfo[]> {
    const warningLedgers = thresholds.warningLedgers ?? DEFAULT_WARNING_LEDGERS;

    const [latestLedger, entriesResponse] = await Promise.all([
        client.getLatestLedger(),
        client.getLedgerEntries(...keys),
    ]);

    const currentLedger = latestLedger.sequence;

    return keys.map((key) => {
        const entry = entriesResponse.entries.find(
            (e) => e.key.toXDR('base64') === key.toXDR('base64'),
        );

        const liveUntilLedger = entry?.liveUntilLedgerSeq ?? null;
        const remainingLedgers =
            liveUntilLedger !== null ? liveUntilLedger - currentLedger : null;
        const isExpired = liveUntilLedger !== null && liveUntilLedger <= currentLedger;
        const isNearExpiration =
            !isExpired && remainingLedgers !== null && remainingLedgers < warningLedgers;

        return { key, liveUntilLedger, currentLedger, remainingLedgers, isExpired, isNearExpiration };
    });
}

// ── TTL extension transaction builder ────────────────────────────────────────

/**
 * Build an unsigned `ExtendFootprintTtl` transaction for the given keys.
 *
 * The transaction must be signed and submitted by the caller. Simulate it
 * first via `SorobanRpc.Server.prepareTransaction` before signing.
 *
 * @param keys - Ledger keys whose TTL should be extended
 * @param sourcePublicKey - Account that will sign and pay fees
 * @param thresholds - Optional TTL thresholds (defaults used when omitted)
 * @param client - Optional Soroban RPC client override (for testing)
 * @returns Base64 XDR of the prepared unsigned transaction
 */
export async function buildTtlExtensionTransaction(
    keys: xdr.LedgerKey[],
    sourcePublicKey: string,
    thresholds: TtlThresholds = {},
    client: Pick<SorobanRpc.Server, 'getAccount' | 'prepareTransaction'> = new SorobanRpc.Server(
        getSorobanRpcUrl(),
        { allowHttp: false },
    ),
): Promise<string> {
    const extendToLedgers = thresholds.extendToLedgers ?? DEFAULT_EXTEND_TO_LEDGERS;

    const account = await client.getAccount(sourcePublicKey);

    const sorobanData = new SorobanDataBuilder()
        .setReadOnly(keys)
        .build();

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: getNetworkPassphrase(),
    })
        .addOperation(Operation.extendFootprintTtl({ extendTo: extendToLedgers }))
        .setSorobanData(sorobanData)
        .setTimeout(30)
        .build();

    const prepared = await client.prepareTransaction(tx);
    return prepared.toXDR();
}

// ── High-level contract TTL check ────────────────────────────────────────────

/**
 * Check whether a contract's instance entry is approaching expiration and,
 * if so, build a TTL extension transaction automatically.
 *
 * @param contractId - The contract address (C...)
 * @param sourcePublicKey - Account to use when building the extension transaction
 * @param thresholds - Optional TTL classification and extension thresholds
 * @param ttlClient - Optional client override for TTL queries (for testing)
 * @param txClient - Optional client override for transaction building (for testing)
 * @returns `{ ok: true, status }` on success, `{ ok: false, error }` on failure
 *
 * @example
 * ```typescript
 * const result = await checkContractTtl(contractId, operatorKey);
 * if (result.ok && result.status.extensionTxXdr) {
 *   const signedXdr = await walletSign(result.status.extensionTxXdr);
 *   await sendSorobanTransaction(signedXdr);
 * }
 * ```
 */
export async function checkContractTtl(
    contractId: string,
    sourcePublicKey: string,
    thresholds: TtlThresholds = {},
    ttlClient?: Parameters<typeof getLedgerEntryTtl>[2],
    txClient?: Parameters<typeof buildTtlExtensionTransaction>[3],
): Promise<TtlCheckResult> {
    try {
        const instanceKey = buildContractInstanceKey(contractId);
        const [instanceTtl] = await getLedgerEntryTtl([instanceKey], thresholds, ttlClient);

        let extensionTxXdr: string | null = null;
        if (instanceTtl.isNearExpiration || instanceTtl.isExpired) {
            extensionTxXdr = await buildTtlExtensionTransaction(
                [instanceKey],
                sourcePublicKey,
                thresholds,
                txClient,
            );
        }

        return { ok: true, status: { contractId, instanceTtl, extensionTxXdr } };
    } catch (error: unknown) {
        const parsed = parseStellarError(error);
        return { ok: false, error: parsed.message };
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

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
    return config.stellar.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}

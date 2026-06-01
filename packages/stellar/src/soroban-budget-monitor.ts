/**
 * Soroban Contract Execution Budget Monitoring (Issue #089)
 *
 * Tracks CPU instruction count and memory bytes from contract simulation
 * responses and fires configurable alert handlers when usage approaches
 * Soroban protocol hard limits.
 *
 * ## Metrics exposed
 * - cpuInsns: CPU instructions consumed by the invocation
 * - memoryBytes: Memory consumed in bytes
 * - cpuLimitFraction: fraction of the 100 M instruction ceiling
 * - memoryLimitFraction: fraction of the 40 MB memory ceiling
 *
 * ## Alert flow
 * Register a handler with `onBudgetAlert`. It fires whenever either
 * resource meets or exceeds the configured threshold (default 80 %).
 *
 * @see https://developers.stellar.org/docs/smart-contracts/resource-limits-fees
 */

import type { SorobanRpc } from 'stellar-sdk';
import { xdr } from 'stellar-sdk';
import { simulateContractCall } from './soroban';

// ── Soroban Protocol 21 hard limits ──────────────────────────────────────────

/** Maximum CPU instructions per Soroban transaction. */
export const SOROBAN_CPU_INSN_LIMIT = 100_000_000;

/** Maximum memory in bytes per Soroban transaction (40 MB). */
export const SOROBAN_MEMORY_LIMIT_BYTES = 41_943_040;

/** Default fraction (0–1) of a hard limit that triggers an alert. */
export const DEFAULT_ALERT_THRESHOLD = 0.8;

// ── Public types ──────────────────────────────────────────────────────────────

export interface BudgetThresholds {
    /** Fraction 0–1 of the CPU limit at which to alert. Default: 0.8 */
    cpuFraction?: number;
    /** Fraction 0–1 of the memory limit at which to alert. Default: 0.8 */
    memoryFraction?: number;
}

export interface BudgetUsage {
    cpuInsns: bigint;
    memoryBytes: bigint;
    /** cpuInsns / SOROBAN_CPU_INSN_LIMIT */
    cpuLimitFraction: number;
    /** memoryBytes / SOROBAN_MEMORY_LIMIT_BYTES */
    memoryLimitFraction: number;
    /** true when cpuLimitFraction >= configured threshold */
    cpuAlert: boolean;
    /** true when memoryLimitFraction >= configured threshold */
    memoryAlert: boolean;
}

export interface BudgetMetric {
    contractId: string;
    method: string;
    usage: BudgetUsage;
    /** Unix timestamp (ms) when this metric was recorded. */
    timestamp: number;
}

/** Called when one or both budget thresholds are breached. */
export type BudgetAlertHandler = (metric: BudgetMetric) => void;

// ── Module-level state (ring-buffer + handlers) ───────────────────────────────

const MAX_STORED_METRICS = 1_000;
const metricsStore: BudgetMetric[] = [];
const alertHandlers: BudgetAlertHandler[] = [];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register a handler invoked whenever a CPU or memory threshold is breached.
 * Returns an unsubscribe function.
 *
 * @example
 * ```typescript
 * const off = onBudgetAlert((m) => {
 *   if (m.usage.cpuAlert) logger.warn('CPU budget alert', m);
 * });
 * off(); // deregister
 * ```
 */
export function onBudgetAlert(handler: BudgetAlertHandler): () => void {
    alertHandlers.push(handler);
    return () => {
        const idx = alertHandlers.indexOf(handler);
        if (idx !== -1) alertHandlers.splice(idx, 1);
    };
}

/**
 * Flush all recorded budget metrics.
 * Call in test teardown to ensure isolation between test cases.
 */
export function clearBudgetMetrics(): void {
    metricsStore.length = 0;
}

/**
 * Return a read-only snapshot of all recorded budget metrics (newest last).
 */
export function getBudgetMetrics(): readonly BudgetMetric[] {
    return metricsStore;
}

/**
 * Simulate a contract invocation, record its execution budget, and fire
 * alert handlers if CPU or memory usage meets or exceeds the configured
 * thresholds.
 *
 * @param contractId - The contract address (C...)
 * @param method - Contract method name
 * @param args - XDR-encoded method arguments
 * @param sourcePublicKey - Source account public key
 * @param thresholds - Optional alert thresholds (default: 80 % of hard limit)
 * @param _simulate - Override `simulateContractCall` for unit testing
 * @returns `BudgetUsage` when cost data is present in the simulation, `null`
 *   when the simulation response does not include cost information
 *
 * @example
 * ```typescript
 * const usage = await trackContractBudget(contractId, 'transfer', args, pubKey);
 * if (usage?.cpuAlert) {
 *   console.warn(`CPU at ${(usage.cpuLimitFraction * 100).toFixed(1)}% of limit`);
 * }
 * ```
 */
export async function trackContractBudget(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    sourcePublicKey: string,
    thresholds: BudgetThresholds = {},
    _simulate: typeof simulateContractCall = simulateContractCall,
): Promise<BudgetUsage | null> {
    const resolved = resolveThresholds(thresholds);
    const simulation = await _simulate(contractId, method, args, sourcePublicKey);
    const usage = extractBudgetUsage(simulation, resolved);
    if (!usage) return null;

    pushMetric({ contractId, method, usage, timestamp: Date.now() });
    return usage;
}

/**
 * Extract execution budget from an existing simulation response without
 * triggering an additional RPC call.
 *
 * @returns `BudgetUsage` when cost data is present, `null` otherwise
 */
export function extractBudgetFromSimulation(
    simulation: SorobanRpc.Api.SimulateTransactionResponse,
    thresholds: BudgetThresholds = {},
): BudgetUsage | null {
    return extractBudgetUsage(simulation, resolveThresholds(thresholds));
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function resolveThresholds(t: BudgetThresholds): Required<BudgetThresholds> {
    return {
        cpuFraction: t.cpuFraction ?? DEFAULT_ALERT_THRESHOLD,
        memoryFraction: t.memoryFraction ?? DEFAULT_ALERT_THRESHOLD,
    };
}

function extractBudgetUsage(
    simulation: SorobanRpc.Api.SimulateTransactionResponse,
    thresholds: Required<BudgetThresholds>,
): BudgetUsage | null {
    if (!('cost' in simulation) || !simulation.cost) return null;

    const cpuInsns = BigInt(simulation.cost.cpuInsns ?? '0');
    const memoryBytes = BigInt(simulation.cost.memBytes ?? '0');
    const cpuLimitFraction = Number(cpuInsns) / SOROBAN_CPU_INSN_LIMIT;
    const memoryLimitFraction = Number(memoryBytes) / SOROBAN_MEMORY_LIMIT_BYTES;

    return {
        cpuInsns,
        memoryBytes,
        cpuLimitFraction,
        memoryLimitFraction,
        cpuAlert: cpuLimitFraction >= thresholds.cpuFraction,
        memoryAlert: memoryLimitFraction >= thresholds.memoryFraction,
    };
}

function pushMetric(metric: BudgetMetric): void {
    if (metricsStore.length >= MAX_STORED_METRICS) {
        metricsStore.shift();
    }
    metricsStore.push(metric);

    if (metric.usage.cpuAlert || metric.usage.memoryAlert) {
        for (const handler of alertHandlers) {
            handler(metric);
        }
    }
}

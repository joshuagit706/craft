import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SorobanRpc } from 'stellar-sdk';
import {
    trackContractBudget,
    extractBudgetFromSimulation,
    onBudgetAlert,
    clearBudgetMetrics,
    getBudgetMetrics,
    SOROBAN_CPU_INSN_LIMIT,
    SOROBAN_MEMORY_LIMIT_BYTES,
    DEFAULT_ALERT_THRESHOLD,
} from './soroban-budget-monitor';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const SOURCE_KEY = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ';

function makeSimulation(cpuInsns: string, memBytes: string): SorobanRpc.Api.SimulateTransactionResponse {
    return {
        cost: { cpuInsns, memBytes },
        minResourceFee: '100',
    } as unknown as SorobanRpc.Api.SimulateTransactionResponse;
}

beforeEach(() => {
    clearBudgetMetrics();
});

describe('trackContractBudget', () => {
    it('returns BudgetUsage with correct fractions', async () => {
        const cpuInsns = String(Math.floor(SOROBAN_CPU_INSN_LIMIT * 0.5));
        const memBytes = String(Math.floor(SOROBAN_MEMORY_LIMIT_BYTES * 0.25));
        const mockSimulate = vi.fn().mockResolvedValue(makeSimulation(cpuInsns, memBytes));

        const usage = await trackContractBudget(CONTRACT_ID, 'ping', [], SOURCE_KEY, {}, mockSimulate);

        expect(usage).not.toBeNull();
        expect(usage!.cpuInsns).toBe(BigInt(cpuInsns));
        expect(usage!.memoryBytes).toBe(BigInt(memBytes));
        expect(usage!.cpuLimitFraction).toBeCloseTo(0.5, 5);
        expect(usage!.memoryLimitFraction).toBeCloseTo(0.25, 5);
    });

    it('sets cpuAlert=false below threshold', async () => {
        const mockSimulate = vi.fn().mockResolvedValue(
            makeSimulation(String(SOROBAN_CPU_INSN_LIMIT * 0.79), '0'),
        );

        const usage = await trackContractBudget(CONTRACT_ID, 'ping', [], SOURCE_KEY, {}, mockSimulate);

        expect(usage!.cpuAlert).toBe(false);
    });

    it('sets cpuAlert=true at exactly the threshold', async () => {
        const atThreshold = String(Math.floor(SOROBAN_CPU_INSN_LIMIT * DEFAULT_ALERT_THRESHOLD));
        const mockSimulate = vi.fn().mockResolvedValue(makeSimulation(atThreshold, '0'));

        const usage = await trackContractBudget(CONTRACT_ID, 'ping', [], SOURCE_KEY, {}, mockSimulate);

        expect(usage!.cpuAlert).toBe(true);
    });

    it('sets memoryAlert=true when memory exceeds threshold', async () => {
        const overThreshold = String(Math.floor(SOROBAN_MEMORY_LIMIT_BYTES * 0.9));
        const mockSimulate = vi.fn().mockResolvedValue(makeSimulation('0', overThreshold));

        const usage = await trackContractBudget(CONTRACT_ID, 'ping', [], SOURCE_KEY, {}, mockSimulate);

        expect(usage!.memoryAlert).toBe(true);
    });

    it('respects custom thresholds', async () => {
        const half = String(SOROBAN_CPU_INSN_LIMIT * 0.6);
        const mockSimulate = vi.fn().mockResolvedValue(makeSimulation(half, '0'));

        const usage = await trackContractBudget(
            CONTRACT_ID, 'ping', [], SOURCE_KEY,
            { cpuFraction: 0.5 },
            mockSimulate,
        );

        expect(usage!.cpuAlert).toBe(true);
    });

    it('returns null when simulation has no cost field', async () => {
        const mockSimulate = vi.fn().mockResolvedValue({
            minResourceFee: '100',
        } as unknown as SorobanRpc.Api.SimulateTransactionResponse);

        const usage = await trackContractBudget(CONTRACT_ID, 'ping', [], SOURCE_KEY, {}, mockSimulate);

        expect(usage).toBeNull();
    });

    it('stores metric in the metrics store', async () => {
        const mockSimulate = vi.fn().mockResolvedValue(makeSimulation('1000000', '512000'));
        await trackContractBudget(CONTRACT_ID, 'transfer', [], SOURCE_KEY, {}, mockSimulate);

        const metrics = getBudgetMetrics();
        expect(metrics).toHaveLength(1);
        expect(metrics[0].contractId).toBe(CONTRACT_ID);
        expect(metrics[0].method).toBe('transfer');
    });
});

describe('alert handler', () => {
    it('fires handler when CPU threshold is exceeded', async () => {
        const handler = vi.fn();
        const off = onBudgetAlert(handler);

        const overThreshold = String(Math.floor(SOROBAN_CPU_INSN_LIMIT * 0.85));
        const mockSimulate = vi.fn().mockResolvedValue(makeSimulation(overThreshold, '0'));

        await trackContractBudget(CONTRACT_ID, 'heavyOp', [], SOURCE_KEY, {}, mockSimulate);

        expect(handler).toHaveBeenCalledOnce();
        expect(handler.mock.calls[0][0].usage.cpuAlert).toBe(true);
        off();
    });

    it('fires handler when memory threshold is exceeded', async () => {
        const handler = vi.fn();
        const off = onBudgetAlert(handler);

        const overMem = String(Math.floor(SOROBAN_MEMORY_LIMIT_BYTES * 0.9));
        const mockSimulate = vi.fn().mockResolvedValue(makeSimulation('0', overMem));

        await trackContractBudget(CONTRACT_ID, 'bigAlloc', [], SOURCE_KEY, {}, mockSimulate);

        expect(handler).toHaveBeenCalledOnce();
        expect(handler.mock.calls[0][0].usage.memoryAlert).toBe(true);
        off();
    });

    it('does not fire handler when both resources are below threshold', async () => {
        const handler = vi.fn();
        const off = onBudgetAlert(handler);

        const mockSimulate = vi.fn().mockResolvedValue(makeSimulation('100', '1024'));
        await trackContractBudget(CONTRACT_ID, 'cheapOp', [], SOURCE_KEY, {}, mockSimulate);

        expect(handler).not.toHaveBeenCalled();
        off();
    });

    it('unsubscribe stops the handler from being called', async () => {
        const handler = vi.fn();
        const off = onBudgetAlert(handler);
        off();

        const over = String(SOROBAN_CPU_INSN_LIMIT);
        const mockSimulate = vi.fn().mockResolvedValue(makeSimulation(over, '0'));
        await trackContractBudget(CONTRACT_ID, 'op', [], SOURCE_KEY, {}, mockSimulate);

        expect(handler).not.toHaveBeenCalled();
    });
});

describe('extractBudgetFromSimulation', () => {
    it('computes usage without an RPC call', () => {
        const sim = makeSimulation('50000000', '20000000');
        const usage = extractBudgetFromSimulation(sim);

        expect(usage).not.toBeNull();
        expect(usage!.cpuInsns).toBe(50_000_000n);
        expect(usage!.memoryBytes).toBe(20_000_000n);
        expect(usage!.cpuAlert).toBe(false);
        expect(usage!.memoryAlert).toBe(false);
    });

    it('returns null for simulation without cost', () => {
        const usage = extractBudgetFromSimulation(
            { error: 'failed' } as unknown as SorobanRpc.Api.SimulateTransactionResponse,
        );
        expect(usage).toBeNull();
    });
});

describe('getBudgetMetrics + clearBudgetMetrics', () => {
    it('accumulates metrics across multiple calls', async () => {
        const mockSimulate = vi.fn().mockResolvedValue(makeSimulation('1000', '512'));

        await trackContractBudget(CONTRACT_ID, 'a', [], SOURCE_KEY, {}, mockSimulate);
        await trackContractBudget(CONTRACT_ID, 'b', [], SOURCE_KEY, {}, mockSimulate);

        expect(getBudgetMetrics()).toHaveLength(2);
    });

    it('clearBudgetMetrics empties the store', async () => {
        const mockSimulate = vi.fn().mockResolvedValue(makeSimulation('1000', '512'));
        await trackContractBudget(CONTRACT_ID, 'x', [], SOURCE_KEY, {}, mockSimulate);

        clearBudgetMetrics();

        expect(getBudgetMetrics()).toHaveLength(0);
    });
});

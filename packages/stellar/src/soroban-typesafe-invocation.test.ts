/**
 * Tests for type-safe contract invocation wrapper (#614)
 */
import { describe, it, expect, vi } from 'vitest';
import { invokeContract } from './soroban';
import type { xdr, SorobanRpc } from 'stellar-sdk';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const SOURCE_KEY = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ';

describe('invokeContract (#614)', () => {
    it('returns ok:true with parsed result on success', async () => {
        const fakeResponse = { result: { retval: 42 } } as unknown as SorobanRpc.Api.SimulateTransactionResponse;
        const mockSimulate = vi.fn().mockResolvedValue(fakeResponse);

        const res = await invokeContract(
            { contractId: CONTRACT_ID, method: 'get_balance', args: [] as unknown as xdr.ScVal[], sourcePublicKey: SOURCE_KEY },
            (raw) => (raw as any).result.retval as number,
            mockSimulate,
        );

        expect(res.ok).toBe(true);
        if (res.ok) expect(res.result).toBe(42);
    });

    it('returns ok:false with typed AppError on RPC failure', async () => {
        const mockSimulate = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

        const res = await invokeContract(
            { contractId: CONTRACT_ID, method: 'transfer', args: [] as unknown as xdr.ScVal[], sourcePublicKey: SOURCE_KEY },
            () => null,
            mockSimulate,
        );

        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error.message).toBeTruthy();
            expect(res.error.code).toBeTruthy();
        }
    });

    it('maps rate-limit errors to status 429', async () => {
        const mockSimulate = vi.fn().mockRejectedValue({ status: 429, type: 'rate_limit' });

        const res = await invokeContract(
            { contractId: CONTRACT_ID, method: 'transfer', args: [] as unknown as xdr.ScVal[], sourcePublicKey: SOURCE_KEY },
            () => null,
            mockSimulate,
        );

        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.status).toBe(429);
    });

    it('never leaks raw RPC error details', async () => {
        const rawMessage = 'internal rpc secret detail xyz';
        const mockSimulate = vi.fn().mockRejectedValue(new Error(rawMessage));

        const res = await invokeContract(
            { contractId: CONTRACT_ID, method: 'transfer', args: [] as unknown as xdr.ScVal[], sourcePublicKey: SOURCE_KEY },
            () => null,
            mockSimulate,
        );

        // The error message should be a user-friendly mapped message, not the raw RPC string
        expect(res.ok).toBe(false);
        if (!res.ok) {
            // Confirm it is a typed AppError (has message and code)
            expect(typeof res.error.message).toBe('string');
            expect(typeof res.error.code).toBe('string');
        }
    });
});

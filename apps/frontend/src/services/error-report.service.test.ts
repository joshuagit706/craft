/**
 * Tests for ErrorReportService — deduplication and batching logic
 *
 * Coverage:
 *  - Identical fingerprints are deduplicated (occurrence count incremented)
 *  - Different fingerprints produce separate batch entries
 *  - Batch flushes on window expiry (fake timers)
 *  - Batch flushes when maxBatchSize is reached
 *  - Occurrence count is correct after multiple duplicates
 *  - Flush writes all pending reports and clears the batch
 *  - Flush on empty batch is a no-op
 *  - Fingerprint generation is deterministic
 *
 * Issue: #572
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorReportService } from './error-report.service';

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockInsert = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        from: (_table: string) => ({
            insert: mockInsert,
            select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockResolvedValue({ data: [], error: null }),
                }),
            }),
        }),
    }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeService(batchWindowMs = 1_000, maxBatchSize = 10) {
    let now = 0;
    const timers: Map<number, { fn: () => void; delay: number }> = new Map();
    let nextId = 1;

    const fakeNow = () => now;
    const fakeSetTimeout = (fn: () => void, delay: number) => {
        const id = nextId++;
        timers.set(id, { fn, delay });
        return id as unknown as ReturnType<typeof setTimeout>;
    };
    const fakeClearTimeout = (id: ReturnType<typeof setTimeout>) => {
        timers.delete(id as unknown as number);
    };

    const advanceTime = async (ms: number) => {
        now += ms;
        for (const [id, { fn, delay }] of [...timers.entries()]) {
            if (delay <= ms) {
                timers.delete(id);
                await fn();
            }
        }
    };

    const service = new ErrorReportService(
        batchWindowMs,
        maxBatchSize,
        fakeNow,
        fakeSetTimeout as any,
        fakeClearTimeout as any,
    );

    return { service, advanceTime };
}

const REQ_A = {
    correlationId: 'c1',
    description: 'Error A',
    errorContext: { message: 'Something broke', code: 'ERR_A' },
};

const REQ_B = {
    correlationId: 'c2',
    description: 'Error B',
    errorContext: { message: 'Something else broke', code: 'ERR_B' },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ErrorReportService — deduplication and batching', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockInsert.mockResolvedValue({ error: null });
    });

    // ── Fingerprint ────────────────────────────────────────────────────────────

    describe('fingerprint()', () => {
        it('produces the same fingerprint for the same userId + error code', () => {
            const { service } = makeService();
            const fp1 = service.fingerprint('u1', { message: 'oops', code: 'ERR_X' });
            const fp2 = service.fingerprint('u1', { message: 'oops', code: 'ERR_X' });
            expect(fp1).toBe(fp2);
        });

        it('produces different fingerprints for different users', () => {
            const { service } = makeService();
            const fp1 = service.fingerprint('u1', { message: 'oops', code: 'ERR_X' });
            const fp2 = service.fingerprint('u2', { message: 'oops', code: 'ERR_X' });
            expect(fp1).not.toBe(fp2);
        });

        it('falls back to message when code is absent', () => {
            const { service } = makeService();
            const fp = service.fingerprint('u1', { message: 'raw message' });
            expect(fp).toContain('raw message');
        });

        it('prefers code over message for identity', () => {
            const { service } = makeService();
            const fpWithCode = service.fingerprint('u1', { message: 'msg', code: 'CODE' });
            const fpNoCode = service.fingerprint('u1', { message: 'msg' });
            expect(fpWithCode).not.toBe(fpNoCode);
        });
    });

    // ── Deduplication ──────────────────────────────────────────────────────────

    describe('deduplication', () => {
        it('merges identical reports into one batch entry', async () => {
            const { service } = makeService();
            await service.submit('u1', REQ_A);
            await service.submit('u1', REQ_A);
            await service.submit('u1', REQ_A);

            await service.flush();

            expect(mockInsert).toHaveBeenCalledOnce();
            const rows = mockInsert.mock.calls[0][0] as any[];
            expect(rows).toHaveLength(1);
            expect(rows[0].occurrence_count).toBe(3);
        });

        it('keeps distinct fingerprints as separate entries', async () => {
            const { service } = makeService();
            await service.submit('u1', REQ_A);
            await service.submit('u1', REQ_B);

            await service.flush();

            const rows = mockInsert.mock.calls[0][0] as any[];
            expect(rows).toHaveLength(2);
        });

        it('treats same error from different users as separate entries', async () => {
            const { service } = makeService();
            await service.submit('u1', REQ_A);
            await service.submit('u2', REQ_A);

            await service.flush();

            const rows = mockInsert.mock.calls[0][0] as any[];
            expect(rows).toHaveLength(2);
        });

        it('increments occurrence count correctly for many duplicates', async () => {
            const { service } = makeService();
            for (let i = 0; i < 7; i++) {
                await service.submit('u1', REQ_A);
            }

            await service.flush();

            const rows = mockInsert.mock.calls[0][0] as any[];
            expect(rows[0].occurrence_count).toBe(7);
        });
    });

    // ── Batch window flush ─────────────────────────────────────────────────────

    describe('time-window flush', () => {
        it('flushes automatically when the batch window expires', async () => {
            const { service, advanceTime } = makeService(1_000);
            await service.submit('u1', REQ_A);

            expect(mockInsert).not.toHaveBeenCalled();

            await advanceTime(1_000);

            expect(mockInsert).toHaveBeenCalledOnce();
        });

        it('does not flush before the window expires', async () => {
            const { service, advanceTime } = makeService(1_000);
            await service.submit('u1', REQ_A);

            await advanceTime(500);

            expect(mockInsert).not.toHaveBeenCalled();
        });

        it('clears the batch after a window flush', async () => {
            const { service, advanceTime } = makeService(1_000);
            await service.submit('u1', REQ_A);
            await advanceTime(1_000);

            // Second flush should be a no-op (batch already cleared)
            await service.flush();

            expect(mockInsert).toHaveBeenCalledOnce();
        });
    });

    // ── Count-threshold flush ──────────────────────────────────────────────────

    describe('count-threshold flush', () => {
        it('flushes immediately when maxBatchSize is reached', async () => {
            const { service } = makeService(60_000, 3);

            await service.submit('u1', { ...REQ_A, errorContext: { message: 'e1', code: 'C1' } });
            await service.submit('u1', { ...REQ_A, errorContext: { message: 'e2', code: 'C2' } });
            expect(mockInsert).not.toHaveBeenCalled();

            await service.submit('u1', { ...REQ_A, errorContext: { message: 'e3', code: 'C3' } });
            expect(mockInsert).toHaveBeenCalledOnce();
        });

        it('writes exactly maxBatchSize rows on threshold flush', async () => {
            const { service } = makeService(60_000, 3);

            await service.submit('u1', { ...REQ_A, errorContext: { message: 'e1', code: 'C1' } });
            await service.submit('u1', { ...REQ_A, errorContext: { message: 'e2', code: 'C2' } });
            await service.submit('u1', { ...REQ_A, errorContext: { message: 'e3', code: 'C3' } });

            const rows = mockInsert.mock.calls[0][0] as any[];
            expect(rows).toHaveLength(3);
        });
    });

    // ── Manual flush ──────────────────────────────────────────────────────────

    describe('flush()', () => {
        it('is a no-op when the batch is empty', async () => {
            const { service } = makeService();
            await service.flush();
            expect(mockInsert).not.toHaveBeenCalled();
        });

        it('throws when the database insert fails', async () => {
            mockInsert.mockResolvedValue({ error: { message: 'DB down' } });
            const { service } = makeService();
            await service.submit('u1', REQ_A);

            await expect(service.flush()).rejects.toThrow('Failed to flush error reports: DB down');
        });

        it('writes occurrence_count=1 for a single non-duplicate report', async () => {
            const { service } = makeService();
            await service.submit('u1', REQ_A);
            await service.flush();

            const rows = mockInsert.mock.calls[0][0] as any[];
            expect(rows[0].occurrence_count).toBe(1);
        });
    });
});

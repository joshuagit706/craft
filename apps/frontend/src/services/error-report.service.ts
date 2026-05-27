import { createClient } from '@/lib/supabase/server';
import type {
    ErrorReport,
    ErrorReportStatus,
    SubmitErrorReportRequest,
    ErrorContext,
} from '@craft/types';

/**
 * Deduplication & Batching Strategy
 *
 * **Fingerprint deduplication**: Each incoming report is fingerprinted by
 * `(userId, errorContext.code ?? errorContext.message)`. If an identical
 * fingerprint arrives within the active batch window the occurrence count is
 * incremented rather than creating a new entry.
 *
 * **Batch window**: Reports are held in memory for `batchWindowMs`
 * (default 5 000 ms). The batch is flushed automatically when the window
 * expires OR when the pending count reaches `maxBatchSize` (default 10).
 *
 * **Flush**: On flush every unique (deduplicated) report is written to the
 * database in a single `insert` call. The `occurrence_count` field records
 * how many duplicate events were merged.
 */

interface PendingReport {
    userId: string;
    req: SubmitErrorReportRequest;
    occurrences: number;
    firstSeen: number;
}

export class ErrorReportService {
    private readonly batchWindowMs: number;
    private readonly maxBatchSize: number;

    /** fingerprint → pending report */
    private batch = new Map<string, PendingReport>();
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        batchWindowMs = 5_000,
        maxBatchSize = 10,
        private readonly _now: () => number = () => Date.now(),
        private readonly _setTimeout: typeof setTimeout = setTimeout,
        private readonly _clearTimeout: typeof clearTimeout = clearTimeout,
    ) {
        this.batchWindowMs = batchWindowMs;
        this.maxBatchSize = maxBatchSize;
    }

    // ── Fingerprint ────────────────────────────────────────────────────────────

    /** Stable fingerprint for deduplication: userId + error identity. */
    fingerprint(userId: string, ctx: ErrorContext): string {
        const identity = ctx.code ?? ctx.message;
        return `${userId}::${identity}`;
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Buffer a report for batched submission.
     * Identical fingerprints within the window increment the occurrence count.
     */
    async submit(
        userId: string,
        req: SubmitErrorReportRequest,
    ): Promise<void> {
        const key = this.fingerprint(userId, req.errorContext);
        const existing = this.batch.get(key);

        if (existing) {
            existing.occurrences += 1;
        } else {
            this.batch.set(key, { userId, req, occurrences: 1, firstSeen: this._now() });
        }

        if (this.batch.size >= this.maxBatchSize) {
            await this.flush();
            return;
        }

        if (!this.flushTimer) {
            this.flushTimer = this._setTimeout(() => {
                this.flush().catch(() => {/* swallow — caller cannot await timer */});
            }, this.batchWindowMs);
        }
    }

    /**
     * Flush all pending reports to the database immediately.
     * Called automatically on window expiry or count threshold.
     */
    async flush(): Promise<void> {
        if (this.flushTimer !== null) {
            this._clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        if (this.batch.size === 0) return;

        const pending = [...this.batch.values()];
        this.batch.clear();

        const supabase = createClient();
        const rows = pending.map(({ userId, req, occurrences }) => ({
            user_id: userId,
            correlation_id: req.correlationId ?? null,
            description: req.description,
            error_context: req.errorContext as any,
            occurrence_count: occurrences,
            status: 'open',
        }));

        const { error } = await supabase.from('error_reports').insert(rows);
        if (error) {
            throw new Error(`Failed to flush error reports: ${error.message}`);
        }
    }

    /**
     * List all reports for a given user, newest first.
     */
    async listForUser(userId: string): Promise<ErrorReport[]> {
        const supabase = createClient();

        const { data, error } = await supabase
            .from('error_reports')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) {
            throw new Error(`Failed to list error reports: ${error.message}`);
        }

        return (data ?? []).map((row) => this.mapRow(row));
    }

    private mapRow(row: any): ErrorReport {
        return {
            id: row.id,
            userId: row.user_id,
            correlationId: row.correlation_id ?? undefined,
            description: row.description,
            errorContext: row.error_context,
            status: row.status as ErrorReportStatus,
            createdAt: new Date(row.created_at),
        };
    }
}

export const errorReportService = new ErrorReportService();

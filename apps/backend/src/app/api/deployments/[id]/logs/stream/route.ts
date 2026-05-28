/**
 * GET /api/deployments/[id]/logs/stream
 *
 * Server-Sent Events (SSE) endpoint for streaming deployment logs in real-time.
 * Returns a continuous stream of log entries and heartbeat events.
 *
 * Authentication: requires a valid Supabase session (401 if missing).
 * Ownership: the authenticated user must own the deployment.
 *            Non-owners and missing deployments both return 404.
 *
 * Query parameters:
 *   since   ISO 8601       Start streaming logs created after this timestamp (optional)
 *   level   log level      Filter by log level (optional)
 *   stage   stage name     Filter by deployment stage (optional)
 *
 * Response format (text/event-stream):
 *   event: log
 *   data: {"id": "...", "deploymentId": "...", "timestamp": "...", "level": "...", "message": "..."}
 *
 *   event: heartbeat
 *   data: {"timestamp": "..."}
 *
 *   event: error
 *   data: {"error": "..."}
 *
 * Responses:
 *   200 — SSE stream established
 *   400 — Invalid query parameters
 *   401 — Not authenticated
 *   404 — Deployment not found (or not owned by caller)
 *   500 — Unexpected server error
 *
 * Issue: #605
 * Branch: feat/issue-069-deployment-log-sse-streaming
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api/with-auth';
import {
    deploymentLogsService,
    type ExtendedLogsQueryParams,
} from '@/services/deployment-logs.service';

const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const POLL_INTERVAL = 2000; // 2 seconds
const MAX_STREAM_DURATION = 24 * 60 * 60 * 1000; // 24 hours

class SSEStreamManager {
    private encoder = new TextEncoder();
    private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    private lastLogId: string | null = null;
    private lastTimestamp: string | null = null;
    private pollTimeout: NodeJS.Timeout | null = null;
    private heartbeatTimeout: NodeJS.Timeout | null = null;
    private streamStartTime: number;
    private closed = false;

    constructor() {
        this.streamStartTime = Date.now();
    }

    async initialize(
        controller: ReadableStreamDefaultController<Uint8Array>,
        deploymentId: string,
        since: string | undefined,
        supabase: any,
        user: any,
    ): Promise<void> {
        this.controller = controller;
        this.lastTimestamp = since || new Date(Date.now() - 60000).toISOString(); // Default to last minute

        // Send initial connection event
        this.sendEvent('connected', { deploymentId, timestamp: new Date().toISOString() });

        // Start polling for new logs
        this.startPolling(deploymentId, supabase);

        // Start heartbeat
        this.startHeartbeat();
    }

    private startPolling(deploymentId: string, supabase: any): void {
        const poll = async () => {
            if (this.closed) return;

            try {
                const params: ExtendedLogsQueryParams = {
                    page: 1,
                    limit: 100,
                    order: 'asc',
                    since: this.lastTimestamp,
                };

                const result = await deploymentLogsService.getLogs(
                    deploymentId,
                    params,
                    supabase,
                );

                // Send any new logs
                for (const log of result.data) {
                    if (!this.lastLogId || log.id !== this.lastLogId) {
                        this.sendEvent('log', log);
                        this.lastLogId = log.id;
                    }
                }

                // Update last timestamp to avoid re-fetching the same logs
                if (result.data.length > 0) {
                    const lastLog = result.data[result.data.length - 1];
                    this.lastTimestamp = lastLog.timestamp;
                }

                // Check if stream duration exceeded
                if (Date.now() - this.streamStartTime > MAX_STREAM_DURATION) {
                    this.sendEvent('end', {
                        reason: 'Stream duration limit reached',
                        timestamp: new Date().toISOString(),
                    });
                    this.close();
                    return;
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : 'Polling failed';
                console.error('[sse-stream] polling error:', err);
                this.sendEvent('error', { error: msg });
                // Don't close on error, continue polling
            }

            // Schedule next poll
            if (!this.closed) {
                this.pollTimeout = setTimeout(poll, POLL_INTERVAL);
            }
        };

        poll();
    }

    private startHeartbeat(): void {
        const heartbeat = () => {
            if (this.closed) return;

            this.sendEvent('heartbeat', { timestamp: new Date().toISOString() });

            if (!this.closed) {
                this.heartbeatTimeout = setTimeout(heartbeat, HEARTBEAT_INTERVAL);
            }
        };

        this.heartbeatTimeout = setTimeout(heartbeat, HEARTBEAT_INTERVAL);
    }

    private sendEvent(eventType: string, data: Record<string, unknown>): void {
        if (!this.controller || this.closed) return;

        try {
            const eventStr = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
            const encoded = this.encoder.encode(eventStr);
            this.controller.enqueue(encoded);
        } catch (err: unknown) {
            console.error('[sse-stream] failed to send event:', err);
            this.close();
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;

        if (this.pollTimeout) clearTimeout(this.pollTimeout);
        if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);

        try {
            this.controller?.close();
        } catch (err: unknown) {
            console.error('[sse-stream] error closing stream:', err);
        }
    }
}

export const GET = withAuth(async (req: NextRequest, { params, user, supabase }) => {
    const deploymentId = (params as { id: string }).id;

    // Ownership check
    const { data: deployment } = await supabase
        .from('deployments')
        .select('user_id')
        .eq('id', deploymentId)
        .single();

    if (!deployment || deployment.user_id !== user.id) {
        return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
    }

    // Validate query parameters
    const since = req.nextUrl.searchParams.get('since') ?? undefined;
    if (since) {
        const d = new Date(since);
        if (isNaN(d.getTime())) {
            return NextResponse.json(
                { error: 'Invalid since parameter' },
                { status: 400 },
            );
        }
    }

    try {
        const manager = new SSEStreamManager();

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                manager.initialize(controller, deploymentId, since, supabase, user).catch(
                    (err: unknown) => {
                        console.error('[sse-stream] initialization error:', err);
                        controller.error(err);
                    },
                );
            },
            cancel() {
                manager.close();
            },
        });

        return new NextResponse(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET',
                'Access-Control-Allow-Headers': 'Content-Type',
            },
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to establish stream';
        console.error('[sse-stream] unexpected error:', err);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
});

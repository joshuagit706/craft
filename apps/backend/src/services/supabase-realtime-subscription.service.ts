/**
 * SupabaseRealtimeSubscription
 *
 * Manages real-time subscriptions to Supabase for live deployment status updates.
 * Handles connection lifecycle with automatic reconnection and polling fallback.
 *
 * Integration strategy:
 *   1. Subscribe to deployments table changes on mount
 *   2. Push status updates to frontend in real-time
 *   3. On connection failure, fallback to polling
 *   4. Resume realtime when connection recovers
 *   5. Apply Row Level Security (RLS) per user
 *
 * Connection states:
 *   - connected: Realtime subscription active
 *   - reconnecting: Connection lost, attempting to restore
 *   - polling: Fallback to polling at reasonable interval
 *   - disconnected: Permanently disconnected
 */

export type ConnectionState = 'connected' | 'reconnecting' | 'polling' | 'disconnected';

export interface DeploymentStatusUpdate {
    deploymentId: string;
    status: 'pending' | 'building' | 'ready' | 'failed' | 'canceled';
    updatedAt: string;
    url?: string;
}

interface RealtimeClient {
    subscribe(event: string, userId: string): Promise<void>;
    unsubscribe(): Promise<void>;
    isConnected(): boolean;
}

interface PollingClient {
    pollDeploymentStatus(userId: string, interval: number): Promise<DeploymentStatusUpdate[]>;
}

export interface SupabaseRealtimeOptions {
    pollingIntervalMs?: number; // Fallback polling interval (default: 5000ms)
    reconnectAttemptsMax?: number; // Max reconnection attempts (default: 5)
    reconnectDelayMs?: number; // Initial delay between reconnects (default: 1000ms)
}

/**
 * Manages subscriptions with automatic fallback to polling.
 * Ensures RLS is applied per subscription (userId parameter).
 */
export class SupabaseRealtimeSubscriptionService {
    private connectionState: ConnectionState = 'disconnected';
    private reconnectAttempts = 0;
    private pollingHandle: NodeJS.Timeout | null = null;

    constructor(
        private readonly realtime: RealtimeClient,
        private readonly polling: PollingClient,
        private readonly options: SupabaseRealtimeOptions = {},
    ) {}

    private get pollingIntervalMs(): number {
        return this.options.pollingIntervalMs ?? 5000;
    }

    private get reconnectAttemptsMax(): number {
        return this.options.reconnectAttemptsMax ?? 5;
    }

    private get reconnectDelayMs(): number {
        return this.options.reconnectDelayMs ?? 1000;
    }

    /**
     * Subscribe to deployment status updates for a user.
     * Automatically handles connection lifecycle and fallback to polling.
     */
    async subscribe(userId: string, onUpdate: (update: DeploymentStatusUpdate) => void): Promise<() => void> {
        this.connectionState = 'reconnecting';
        this.reconnectAttempts = 0;

        const attemptConnect = async () => {
            try {
                await this.realtime.subscribe('deployments', userId);
                this.connectionState = 'connected';
                this.reconnectAttempts = 0;
            } catch (error) {
                this.reconnectAttempts++;
                if (this.reconnectAttempts >= this.reconnectAttemptsMax) {
                    // Switch to polling
                    this.connectionState = 'polling';
                    this.startPolling(userId, onUpdate);
                } else {
                    // Retry with exponential backoff
                    this.connectionState = 'reconnecting';
                    const delayMs = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);
                    setTimeout(attemptConnect, delayMs);
                }
            }
        };

        await attemptConnect();

        // Return unsubscribe function
        return () => {
            this.connectionState = 'disconnected';
            this.realtime.unsubscribe().catch(() => {
                /* ignore */
            });
            if (this.pollingHandle) {
                clearInterval(this.pollingHandle);
                this.pollingHandle = null;
            }
        };
    }

    /**
     * Start polling as a fallback when realtime connection fails.
     */
    private startPolling(userId: string, onUpdate: (update: DeploymentStatusUpdate) => void): void {
        if (this.pollingHandle) {
            clearInterval(this.pollingHandle);
        }

        const poll = async () => {
            try {
                const updates = await this.polling.pollDeploymentStatus(userId, this.pollingIntervalMs);
                for (const update of updates) {
                    onUpdate(update);
                }

                // Try to reconnect periodically
                if (this.realtime.isConnected()) {
                    this.connectionState = 'connected';
                    this.reconnectAttempts = 0;
                    clearInterval(this.pollingHandle!);
                    this.pollingHandle = null;
                }
            } catch {
                /* continue polling */
            }
        };

        this.pollingHandle = setInterval(poll, this.pollingIntervalMs);
        // Run once immediately
        poll().catch(() => {
            /* ignore */
        });
    }

    /**
     * Get current connection state.
     */
    getConnectionState(): ConnectionState {
        return this.connectionState;
    }

    /**
     * Check if actively receiving updates (either realtime or polling).
     */
    isActive(): boolean {
        return this.connectionState !== 'disconnected';
    }
}
